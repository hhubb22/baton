package node

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/sidecar"
)

const projectRuntimeVersion = "0.1.0"

const runtimeReportInterval = 5 * time.Second
const runtimeCollectTimeout = 2 * time.Second

type runtimeReports struct {
	latest  atomic.Pointer[protocol.RuntimeReport]
	changed chan struct{}
	refresh chan struct{}
}

// collectRuntimeReports 在整个 Maintain 生命周期中只有一个采集者。阻塞文件系统也不会随重连增加采集协程。
func collectRuntimeReports(ctx context.Context, dir string) *runtimeReports {
	r := &runtimeReports{changed: make(chan struct{}, 1), refresh: make(chan struct{}, 1)}
	go func() {
		for ctx.Err() == nil {
			collectCtx, cancel := context.WithTimeout(ctx, runtimeCollectTimeout)
			report := collectRuntimeReport(collectCtx, dir)
			cancel()
			r.latest.Store(&report)
			select {
			case r.changed <- struct{}{}:
			default:
			}
			timer := time.NewTimer(runtimeReportInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-r.refresh:
				timer.Stop()
			case <-timer.C:
			}
		}
	}()
	return r
}

func collectRuntimeReport(ctx context.Context, dir string) protocol.RuntimeReport {
	cfg, err := ReadProjectExec(dir)
	if err != nil {
		cfg = protocol.RuntimeExec{Shell: DefaultProjectShell()}
	}
	r := protocol.RuntimeReport{Exec: cfg, Truncated: err != nil}
	r.ProjectRuntime = probeProjectRuntime(ctx)
	roots, repos, truncated := fileaccess.ScanRuntimeRoots(ctx, dir)
	r.Roots, r.Repos, r.Truncated = roots, repos, r.Truncated || truncated
	for {
		if _, err := protocol.RuntimeReportJSON(r); err == nil {
			return r
		}
		r.Truncated = true
		if len(r.Repos) > 0 {
			r.Repos = r.Repos[:len(r.Repos)-1]
			continue
		}
		if len(r.Roots) > 0 {
			r.Roots = r.Roots[:len(r.Roots)-1]
			continue
		}
		r.Exec = protocol.RuntimeExec{Shell: "/bin/sh"}
	}
}

// probeProjectRuntime 仅调用无推理请求的 probe；失败或未知字段不会进入中心报告。
func probeProjectRuntime(ctx context.Context) *protocol.ProjectRuntime {
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	cmd, err := sidecar.Command(probeCtx, "project-agent", projectRuntimeVersion, "baton-project-runtime", "probe")
	if err != nil {
		return nil
	}
	host, err := os.Executable()
	if err != nil {
		return nil
	}
	cmd.Env = append(os.Environ(), "BATON_SIDECAR_HOST="+host)
	out, err := sidecar.Capture(probeCtx, cmd, 16<<10)
	if err != nil {
		return nil
	}
	var p protocol.ProjectRuntime
	if protocol.DecodeRuntimeMessage(out, &p) != nil || protocol.ValidateProjectRuntime(&p) != nil || p.Version != projectRuntimeVersion {
		return nil
	}
	sort.Slice(p.Providers, func(i, j int) bool { return p.Providers[i].Provider < p.Providers[j].Provider })
	return &p
}

type runtimeReportSender struct {
	mu        sync.Mutex
	current   *runtimeReportConnection
	messageID string
	raw       []byte
	acked     bool
}

type runtimeReportConnection struct {
	sender *runtimeReportSender
	ready  chan struct{}
	sent   bool
}

func (s *runtimeReportSender) connect() *runtimeReportConnection {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 已确认的报告在新连接上重新发送；未确认的报告保留原消息标识和内容。
	if s.acked {
		s.messageID, s.raw, s.acked = "", nil, false
	}
	c := &runtimeReportConnection{sender: s, ready: make(chan struct{}, 1)}
	s.current = c
	return c
}

func (c *runtimeReportConnection) close() {
	s := c.sender
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == c {
		s.current = nil
	}
}

func (c *runtimeReportConnection) note(env protocol.Envelope) {
	var result protocol.RuntimeReportResult
	if json.Unmarshal(env.Body, &result) != nil || result.Type != protocol.BodyRuntimeReportResult || !result.OK {
		return
	}
	s := c.sender
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == c && c.sent && s.messageID == env.CorrelationID && !s.acked {
		s.acked = true
		select {
		case c.ready <- struct{}{}:
		default:
		}
	}
}

func (c *runtimeReportConnection) send(ctx context.Context, w *wsWriter, reports *runtimeReports) error {
	if reports == nil {
		return nil
	}
	r := reports.latest.Load()
	if r == nil {
		return nil
	}
	raw, err := protocol.RuntimeReportJSON(*r)
	if err != nil {
		return nil
	}
	s := c.sender
	s.mu.Lock()
	if s.current != c || ctx.Err() != nil {
		s.mu.Unlock()
		return nil
	}
	if s.messageID == "" || (s.acked && !bytes.Equal(s.raw, raw)) {
		messageID, err := identity.NewUUID()
		if err != nil {
			s.mu.Unlock()
			return err
		}
		s.messageID, s.raw, s.acked = messageID, raw, false
	}
	if s.acked {
		s.mu.Unlock()
		return nil
	}
	messageID, pending := s.messageID, s.raw
	c.sent = true
	s.mu.Unlock()
	body, err := json.Marshal(struct {
		Type   string          `json:"type"`
		Report json.RawMessage `json:"report"`
	}{Type: protocol.BodyRuntimeReport, Report: pending})
	if err != nil {
		return err
	}
	env, err := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: messageID, Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: body})
	if err != nil {
		return err
	}
	frame, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil {
		return err
	}
	return w.write(ctx, frame)
}
