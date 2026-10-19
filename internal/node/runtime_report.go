package node

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/protocol"
)

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
	binary, err := exec.LookPath("baton-project-runtime")
	if err != nil {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, binary, "probe")
	cmd.WaitDelay = 100 * time.Millisecond
	var out probeOutput
	cmd.Stdout = &out
	if cmd.Run() != nil || out.overflow {
		return nil
	}
	var p protocol.ProjectRuntime
	if protocol.DecodeRuntimeJSON(out.Bytes(), &p) != nil || protocol.ValidateProjectRuntime(&p) != nil {
		return nil
	}
	sort.Slice(p.Providers, func(i, j int) bool { return p.Providers[i].Provider < p.Providers[j].Provider })
	return &p
}

type probeOutput struct {
	buffer   bytes.Buffer
	overflow bool
}

func (b *probeOutput) Len() int      { return b.buffer.Len() }
func (b *probeOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *probeOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > 16<<10 {
		b.overflow = true
	}
	b.buffer.Write(p[:min(n, (16<<10)-b.Len())])
	return n, nil
}

type runtimeReportSender struct {
	ready     chan struct{}
	mu        sync.Mutex
	messageID string
	raw       []byte
	acked     bool
}

func (s *runtimeReportSender) note(env protocol.Envelope) {
	var result protocol.RuntimeReportResult
	if json.Unmarshal(env.Body, &result) != nil || result.Type != protocol.BodyRuntimeReportResult || !result.OK {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.messageID == env.CorrelationID {
		s.acked = true
	}
}

func (s *runtimeReportSender) send(ctx context.Context, w *wsWriter, reports *runtimeReports) error {
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
	s.mu.Lock()
	if !bytes.Equal(s.raw, raw) {
		s.raw, s.acked = raw, false
		s.messageID, err = identity.NewUUID()
	}
	messageID, acked := s.messageID, s.acked
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if acked {
		return nil
	}
	body, err := json.Marshal(protocol.RuntimeReportRequest{Type: protocol.BodyRuntimeReport, Report: *r})
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
