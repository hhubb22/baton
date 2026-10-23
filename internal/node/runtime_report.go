package node

import (
	"bytes"
	"context"
	"encoding/json"
	"os/user"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/projectruntime"
	"baton/internal/protocol"
)

const runtimeReportInterval = 5 * time.Second
const runtimeCollectTimeout = 2 * time.Second

type runtimeReports struct {
	latest  atomic.Pointer[protocol.RuntimeReport]
	agents  atomic.Pointer[[]agentRuntimeReport]
	changed chan struct{}
	refresh chan struct{}
	done    chan struct{}
}

// collectRuntimeReports 在整个 Maintain 生命周期中只有一个采集者。阻塞文件系统也不会随重连增加采集协程。
func collectRuntimeReports(ctx context.Context, dir string, discover RuntimeModelDiscovery, version func(context.Context, string) (string, error), interval time.Duration) *runtimeReports {
	r := &runtimeReports{changed: make(chan struct{}, 1), refresh: make(chan struct{}, 1), done: make(chan struct{})}
	probe := newAgentProbe(discover, version)
	go func() {
		defer close(r.done)
		for ctx.Err() == nil {
			report, agents := collectRuntimeReportUsingProbe(ctx, dir, probe)
			r.agents.Store(&agents)
			r.latest.Store(&report)
			select {
			case r.changed <- struct{}{}:
			default:
			}
			timer := time.NewTimer(interval)
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
	r, _ := collectRuntimeReportWithAgents(ctx, dir)
	return r
}

func collectRuntimeReportWithAgents(ctx context.Context, dir string) (protocol.RuntimeReport, []agentRuntimeReport) {
	return collectRuntimeReportUsingProbe(ctx, dir, defaultAgentProbe())
}

func collectRuntimeReportUsingProbe(ctx context.Context, dir string, probe agentRuntimeProbe) (protocol.RuntimeReport, []agentRuntimeReport) {
	cfg, err := ReadProjectExec(dir)
	if err != nil {
		cfg = protocol.RuntimeExec{Shell: DefaultProjectShell()}
	}
	cfg.User = ""
	r := protocol.RuntimeReport{Exec: cfg, Truncated: err != nil}
	if info, ok := debug.ReadBuildInfo(); ok {
		if info.Main.Version != "(devel)" {
			r.BatondVersion = info.Main.Version
		}
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				r.BatondVersion = setting.Value
			}
		}
	}
	if current, err := user.Current(); err == nil {
		r.User = current.Username
		r.Exec.User = current.Username
	}
	agents := collectAgentRuntimeReports(ctx, cfg, probe)
	for _, a := range agents {
		r.Agents = append(r.Agents, a.RuntimeAgent)
	}
	collectCtx, cancel := context.WithTimeout(ctx, runtimeCollectTimeout)
	defer cancel()
	r.ProjectRuntime = probeProjectRuntime(collectCtx)
	roots, repos, truncated := fileaccess.ScanRuntimeRoots(collectCtx, dir)
	r.Roots, r.Repos, r.Truncated = roots, repos, r.Truncated || truncated
	for {
		if _, err := runtimeReportWireJSON(r, &agents); err == nil {
			return r, agents
		}
		r.Truncated = true
		if len(r.Repos) > 0 {
			r.Repos = r.Repos[:len(r.Repos)-1]
			continue
		}
		removedModel := false
		for pass := 0; pass < 2 && !removedModel; pass++ {
			for i := len(r.Agents) - 1; i >= 0; i-- {
				models := r.Agents[i].Models
				index := len(models) - 1
				if pass == 0 && index >= 0 && models[index].ID == r.Agents[i].DefaultModel {
					index--
				}
				if index < 0 {
					continue
				}
				r.Agents[i].Models = slices.Delete(slices.Clone(models), index, index+1)
				removedModel = true
				break
			}
		}
		if removedModel {
			continue
		}
		if r.ProjectRuntime != nil {
			removed := false
			for i := len(r.ProjectRuntime.Providers) - 1; i >= 0; i-- {
				p := &r.ProjectRuntime.Providers[i]
				if len(p.Models) > 0 {
					p.Models = p.Models[:len(p.Models)-1]
					removed = true
					break
				}
			}
			if removed {
				continue
			}
		}
		if len(r.Roots) > 0 {
			r.Roots = r.Roots[:len(r.Roots)-1]
			continue
		}
		r.Exec = protocol.RuntimeExec{Shell: "/bin/sh"}
	}
}

// probeProjectRuntime 只读取本地状态；探测失败时不生成 Runtime 报告。
func probeProjectRuntime(ctx context.Context) *protocol.ProjectRuntime {
	report, _ := projectruntime.Probe(ctx)
	return report
}

type runtimeReportSender struct {
	mu        sync.Mutex
	current   *runtimeReportConnection
	messageID string
	raw       []byte
	acked     bool
}

type runtimeReportConnection struct {
	reports *runtimeReports
	sender  *runtimeReportSender
	ready   chan struct{}
	sent    bool
}

func (s *runtimeReportSender) connect(reports ...*runtimeReports) *runtimeReportConnection {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 已确认的报告在新连接上重新发送；未确认的报告保留原消息标识和内容。
	if s.acked {
		s.messageID, s.raw, s.acked = "", nil, false
	}
	c := &runtimeReportConnection{sender: s, ready: make(chan struct{}, 1)}
	if len(reports) > 0 {
		c.reports = reports[0]
	}
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
	raw, err := runtimeReportWireJSON(*r, reports.agents.Load())
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
