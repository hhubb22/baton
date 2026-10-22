package node

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"

	"github.com/coder/websocket"
)

var (
	// ErrNeedsReauth 表示连接凭据被拒绝。调用方应停止重连，也不能据此重新注册。
	ErrNeedsReauth = errors.New("需要重新认证")
	// ErrIncarnationConflict 表示另一个进程正占用该节点身份。可以稍后重试，但不能注册新节点。
	ErrIncarnationConflict = errors.New("已有其他进程使用该节点身份")
)

// RunOptions 是一次常驻连接使用的本地身份和 Relay 地址。
type RunOptions struct {
	RelayURL                 string
	Identity                 Identity
	Heartbeat                time.Duration
	RootCAs                  *x509.CertPool
	Logger                   *slog.Logger
	DataDir                  string
	ThreadHost               ThreadHost
	ThreadBudgetBytes        int64
	DiscoverRuntimeModels    RuntimeModelDiscovery
	ProbeRuntimeAgentVersion func(context.Context, string) (string, error)
	reports                  *runtimeReports
	reportSender             *runtimeReportSender
	projectRuntime           *projectRuntimeManager
}

// Maintain 保持到 Relay 的出站连接。同一进程的重连沿用启动时生成的 incarnation。
func Maintain(ctx context.Context, opts RunOptions) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if _, err := ParseRelayURL(opts.RelayURL); err != nil {
		return err
	}
	if err := opts.Identity.complete(); err != nil {
		return errors.New("节点身份不完整")
	}
	if opts.Heartbeat < 100*time.Millisecond || opts.Heartbeat > 2*time.Minute {
		return errors.New("心跳间隔无效")
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	incarnation, err := identity.NewUUID()
	if err != nil {
		return errors.New("无法生成节点化身")
	}
	var ledger *Ledger
	var host *session.Host
	if opts.DataDir != "" {
		release, err := acquireDataLock(opts.DataDir)
		if err != nil {
			return err
		}
		defer release()
		ledger, err = OpenLedger(opts.DataDir)
		if err != nil {
			return err
		}
		defer ledger.Close()
		opts.projectRuntime, err = newProjectRuntimeManager(ctx, ledger)
		if err != nil {
			return err
		}
		defer opts.projectRuntime.close()
		host = &session.Host{DataDir: opts.DataDir, Logger: opts.Logger}
		sessions, err := ledger.WorkerSessions()
		if err != nil {
			return err
		}
		var reconnectable []string
		for _, id := range sessions {
			failures, err := ledger.historyReadFailures(id)
			if err != nil {
				return errors.New("无法读取历史重试状态")
			}
			if failures < historyReadFailureLimit {
				reconnectable = append(reconnectable, id)
			}
		}
		reconnectCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		host.Reconnect(reconnectCtx, reconnectable)
		cancel()
	}
	attempt := 0
	opts.reportSender = &runtimeReportSender{}
	if opts.DataDir != "" {
		opts.reports = collectRuntimeReports(ctx, opts.DataDir, opts.DiscoverRuntimeModels, opts.ProbeRuntimeAgentVersion)
		opts.projectRuntime.reports = opts.reports
	}
	for {
		if ctx.Err() != nil {
			return nil
		}
		started := time.Now()
		err := runOnce(ctx, opts, incarnation, ledger, host)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrNeedsReauth) {
			opts.Logger.Warn("event=needs_reauth", "node_id", opts.Identity.NodeID)
			return ErrNeedsReauth
		}
		if errors.Is(err, ErrIncarnationConflict) {
			opts.Logger.Warn("event=incarnation_conflict", "node_id", opts.Identity.NodeID)
		} else {
			opts.Logger.Info("event=disconnected", "node_id", opts.Identity.NodeID)
		}
		if time.Since(started) >= opts.Heartbeat && !errors.Is(err, ErrIncarnationConflict) {
			attempt = 0
		}
		delay := BackoffDelay(attempt, nil)
		attempt++
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func runOnce(ctx context.Context, opts RunOptions, incarnation string, ledger *Ledger, host *session.Host) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ws, err := dialRelay(ctx, opts)
	if err != nil {
		return err
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	ws.SetReadLimit(protocol.MaxMessageBytes)
	authFrame, err := json.Marshal(struct {
		Kind        string `json:"kind"`
		Token       string `json:"token"`
		Incarnation string `json:"incarnation"`
	}{Kind: protocol.KindAuth, Token: opts.Identity.Credential.Token, Incarnation: incarnation})
	if err != nil {
		return errors.New("无法编码认证请求")
	}
	if err := ws.Write(ctx, websocket.MessageText, authFrame); err != nil {
		return errors.New("无法连接 Coordinator")
	}
	_, raw, err := ws.Read(ctx)
	if err != nil {
		return errors.New("无法连接 Coordinator")
	}
	var result struct {
		Kind string `json:"kind"`
		OK   bool   `json:"ok"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.Kind != protocol.KindAuthResult {
		return errors.New("无法连接 Coordinator")
	}
	if !result.OK {
		if result.Code == protocol.CodeIncarnationConflict {
			return ErrIncarnationConflict
		}
		return ErrNeedsReauth
	}
	opts.Logger.Info("event=connected", "node_id", opts.Identity.NodeID, "incarnation", incarnation)
	var acked atomic.Bool
	var expect atomic.Value
	expect.Store("")
	writer := newWSWriter(ws)
	loop := newStartLoop(ctx, opts.Identity, ledger, host, writer, opts.Logger)
	threadHost := opts.ThreadHost
	if threadHost == nil && host != nil {
		threadHost = newSessionThreadHost(host, ledger, opts.Identity.NodeID)
	}
	loop.threads = newThreadService(ledger, threadHost, opts.ThreadBudgetBytes, opts.Identity.Capabilities, func(ctx context.Context, correlation string, value any) error {
		return writeThreadEnvelope(ctx, writer, correlation, value)
	})
	threadDone := make(chan struct{})
	go func() { defer close(threadDone); loop.threads.run(ctx) }()
	defer func() { cancel(); <-threadDone }()
	if opts.projectRuntime != nil {
		opts.projectRuntime.setLoop(loop)
		defer opts.projectRuntime.setLoop(nil)
	}
	errCh := make(chan error, 1)
	reportSender := opts.reportSender.connect()
	defer reportSender.close()
	var reportChanged <-chan struct{}
	if opts.reports != nil {
		reportChanged = opts.reports.changed
		select {
		case opts.reports.refresh <- struct{}{}:
		default:
		}
	}
	go func() {
		errCh <- readRelay(ctx, writer, &acked, &expect, opts.Logger, opts.Identity, ledger, host, loop, opts.DataDir, reportSender, opts.projectRuntime)
	}()
	var replayBusy atomic.Bool
	replay := func() {
		if !replayBusy.CompareAndSwap(false, true) {
			return
		}
		defer replayBusy.Store(false)
		loop.resendPending(ctx)
	}
	go replay()
	ticker := time.NewTicker(opts.Heartbeat)
	defer ticker.Stop()
	if err := writeSync(ctx, writer, opts, &expect, &acked); err != nil {
		return err
	}
	if err := writeHeartbeat(ctx, writer); err != nil {
		return err
	}
	for {
		select {
		case <-reportChanged:
			if acked.Load() {
				if err := reportSender.send(ctx, writer, opts.reports); err != nil {
					return err
				}
			}
		case <-reportSender.ready:
			if err := reportSender.send(ctx, writer, opts.reports); err != nil {
				return err
			}
		case <-ctx.Done():
			return nil
		case err := <-errCh:
			if errors.Is(err, ErrNeedsReauth) || errors.Is(err, ErrIncarnationConflict) {
				return err
			}
			return errors.New("与 Coordinator 的连接已断开")
		case <-ticker.C:
			if acked.Load() {
				if err := reportSender.send(ctx, writer, opts.reports); err != nil {
					return err
				}
			}
			go replay()
			if !acked.Load() {
				if err := writeSync(ctx, writer, opts, &expect, &acked); err != nil {
					return err
				}
			}
			if err := writeHeartbeat(ctx, writer); err != nil {
				return err
			}
		}
	}
}

func dialRelay(ctx context.Context, opts RunOptions) (*websocket.Conn, error) {
	endpoint, err := ParseRelayURL(opts.RelayURL)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    opts.RootCAs,
	}}}
	ws, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		return nil, errors.New("无法连接 Coordinator")
	}
	return ws, nil
}

func readRelay(ctx context.Context, w *wsWriter, acked *atomic.Bool, expect *atomic.Value, log *slog.Logger, ident Identity, ledger *Ledger, host *session.Host, loop *startLoop, dataDir string, reports *runtimeReportConnection, runtimes ...*projectRuntimeManager) error {
	for {
		_, raw, err := w.ws.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		var head struct {
			Kind string `json:"kind"`
			Code string `json:"code"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			continue
		}
		switch head.Kind {
		case protocol.KindError:
			if head.Code == protocol.CodeInvalidCredential {
				return ErrNeedsReauth
			}
		case protocol.KindEnvelope:
			var wrap struct {
				Envelope protocol.Envelope `json:"envelope"`
			}
			if err := json.Unmarshal(raw, &wrap); err != nil {
				continue
			}
			reports.note(wrap.Envelope)
			if loop != nil && loop.threads != nil && loop.threads.handle(wrap.Envelope) {
				continue
			}
			if len(runtimes) > 0 && runtimes[0] != nil && runtimes[0].handle(wrap.Envelope) {
				continue
			}
			if handleNodeEnvelope(ctx, raw, w, ledger, host, ident.Capabilities, log, loop) {
				continue
			}
			if handleSessionEnvelope(ctx, raw, w, host, ledger) {
				continue
			}
			if handleFileEnvelope(ctx, raw, w, dataDir, log) {
				continue
			}
			var body struct {
				Type string `json:"type"`
				OK   bool   `json:"ok"`
			}
			_ = json.Unmarshal(wrap.Envelope.Body, &body)
			want, _ := expect.Load().(string)
			if body.Type == "node.sync_result" && body.OK && wrap.Envelope.CorrelationID == want && want != "" {
				if acked.CompareAndSwap(false, true) {
					log.Info("event=synced", "node_id", ident.NodeID)
					if loop != nil && loop.threads != nil {
						loop.threads.syncReady()
					}
					select {
					case reports.ready <- struct{}{}:
					default:
					}
				}
			}
		}
	}
}

func writeSync(ctx context.Context, w *wsWriter, opts RunOptions, expect *atomic.Value, acked *atomic.Bool) error {
	if acked.Load() {
		return nil
	}
	messageID, err := identity.NewUUID()
	if err != nil {
		return errors.New("无法同步节点状态")
	}
	body, err := json.Marshal(struct {
		Type         string   `json:"type"`
		DisplayName  string   `json:"display_name"`
		System       string   `json:"system"`
		Role         string   `json:"role"`
		Capabilities []string `json:"capabilities"`
	}{
		Type:         "node.sync",
		DisplayName:  opts.Identity.DisplayName,
		System:       opts.Identity.System,
		Role:         opts.Identity.Role,
		Capabilities: append([]string{}, opts.Identity.Capabilities...),
	})
	if err != nil {
		return errors.New("无法同步节点状态")
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:   protocol.Version,
		MessageID: messageID,
		Route:     protocol.Route{To: protocol.ToControl},
		Priority:  protocol.PriorityControl,
		Body:      body,
	})
	if err != nil {
		return errors.New("无法同步节点状态")
	}
	frame, err := json.Marshal(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return errors.New("无法同步节点状态")
	}
	expect.Store(messageID)
	if err := w.write(ctx, frame); err != nil {
		return errors.New("与 Coordinator 的连接已断开")
	}
	return nil
}

func writeHeartbeat(ctx context.Context, w *wsWriter) error {
	frame, err := json.Marshal(struct {
		Kind string `json:"kind"`
	}{Kind: protocol.KindHeartbeat})
	if err != nil {
		return errors.New("无法发送心跳")
	}
	if err := w.write(ctx, frame); err != nil {
		return errors.New("与 Coordinator 的连接已断开")
	}
	return nil
}

// ParseRelayURL 接受不带用户信息和查询参数的 wss 地址。路径为空时使用节点入口。
func ParseRelayURL(raw string) (string, error) {
	const rejected = "Relay 地址必须是不带凭据和查询参数的 wss 地址"
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || !u.IsAbs() || !strings.EqualFold(u.Scheme, "wss") || u.User != nil {
		return "", errors.New(rejected)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New(rejected)
	}
	u.Scheme = "wss"
	if u.Path == "" || u.Path == "/" {
		u.Path = protocol.NodePath
	}
	return u.String(), nil
}
