package node

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"

	"github.com/coder/websocket"
)

func TestRuntimeProbeContractAndBounds(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", binary, "testdata/runtime_probe.go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建 probe 契约程序失败：%v %s", err, out)
	}
	probeFile := filepath.Join(t.TempDir(), "probe.json")
	t.Setenv("PATH", dir)
	t.Setenv("BATON_TEST_PROBE_FILE", probeFile)
	for _, test := range []struct {
		raw string
		ok  bool
	}{
		{`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"available"}]}`, true},
		{`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"login_required"}]}`, true},
		{`{"version":"0.1.0","providers":[],"token":"secret"}`, false},
		{"slow", false}, {"flood", false}, {"error", false},
	} {
		if err := os.WriteFile(probeFile, []byte(test.raw), 0o600); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		p := probeProjectRuntime(context.Background())
		if (p != nil) != test.ok || time.Since(start) > 3*time.Second {
			t.Fatalf("probe 契约或耗时不正确：%+v %s", p, time.Since(start))
		}
	}
	t.Setenv("PATH", t.TempDir())
	if probeProjectRuntime(context.Background()) != nil {
		t.Fatal("未安装 Runtime 仍产生报告")
	}
}

func TestRuntimeReportPendingSurvivesConnectionAndCollectionChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	frames := make(chan protocol.Envelope, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var frame struct {
				Envelope protocol.Envelope `json:"envelope"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Error(err)
				return
			}
			select {
			case frames <- frame.Envelope:
			case <-ctx.Done():
				return
			}
		}
	}))
	defer server.Close()
	dial := func() *wsWriter {
		t.Helper()
		ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.CloseNow() })
		return newWSWriter(ws)
	}
	reports := &runtimeReports{}
	reports.latest.Store(&protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}})
	sender := &runtimeReportSender{}
	send := func(c *runtimeReportConnection, w *wsWriter) protocol.Envelope {
		t.Helper()
		if err := c.send(ctx, w, reports); err != nil {
			t.Fatal(err)
		}
		select {
		case env := <-frames:
			return env
		case <-ctx.Done():
			t.Fatal("报告未发送")
			return protocol.Envelope{}
		}
	}
	ack := func(env protocol.Envelope) protocol.Envelope {
		return protocol.Envelope{CorrelationID: env.MessageID, Body: json.RawMessage(`{"type":"node.runtime_report_result","ok":true,"report_version":1}`)}
	}
	unchanged := func(want, got protocol.Envelope) {
		t.Helper()
		if want.MessageID != got.MessageID || !bytes.Equal(want.Body, got.Body) {
			t.Fatal("未获成功回执的报告更换了消息标识或内容")
		}
	}
	first, firstWriter := sender.connect(), dial()
	original := send(first, firstWriter)
	reports.latest.Store(&protocol.RuntimeReport{Exec: protocol.RuntimeExec{Enabled: true, Shell: "sh"}})
	unchanged(original, send(first, firstWriter))
	first.close()
	_ = firstWriter.ws.CloseNow()
	first.note(ack(original))
	second, secondWriter := sender.connect(), dial()
	first.note(ack(original))
	first.close()
	second.note(ack(original))
	unchanged(original, send(second, secondWriter))
	// 旧读循环即使在新连接重发之后才交付回执，也不能确认新连接的报告。
	first.note(ack(original))
	unchanged(original, send(second, secondWriter))
	second.note(protocol.Envelope{CorrelationID: original.MessageID, Body: json.RawMessage(`{"type":"node.runtime_report_result","ok":false}`)})
	unchanged(original, send(second, secondWriter))
	second.note(ack(original))
	select {
	case <-second.ready:
	default:
		t.Fatal("成功回执没有触发最新报告发送")
	}
	latest := send(second, secondWriter)
	if latest.MessageID == original.MessageID || bytes.Equal(latest.Body, original.Body) {
		t.Fatal("成功回执后未发送能力变化")
	}
	var request protocol.RuntimeReportRequest
	if json.Unmarshal(latest.Body, &request) != nil || !request.Report.Exec.Enabled {
		t.Fatal("报告未包含最新命令执行开关")
	}
	second.note(ack(original))
	unchanged(latest, send(second, secondWriter))
	second.note(ack(latest))
	second.close()
	_ = secondWriter.ws.CloseNow()
	third, thirdWriter := sender.connect(), dial()
	defer third.close()
	reconnected := send(third, thirdWriter)
	if latest.MessageID == reconnected.MessageID || !bytes.Equal(latest.Body, reconnected.Body) {
		t.Fatal("已确认的报告没有在重连后作为新消息重新发送")
	}
}

func TestRuntimeReportDefaultsAndConfigChange(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	r := collectRuntimeReport(context.Background(), dir)
	if r.Exec.Enabled || r.Exec.Shell == "" || r.ProjectRuntime != nil {
		t.Fatalf("默认报告错误：%+v", r)
	}
	if err := WriteProjectExec(dir, protocol.RuntimeExec{Enabled: true, Shell: "custom-shell"}); err != nil {
		t.Fatal(err)
	}
	r = collectRuntimeReport(context.Background(), dir)
	if !r.Exec.Enabled || r.Exec.Shell != "custom-shell" {
		t.Fatal("开关变化未生效")
	}
	if err := os.WriteFile(filepath.Join(dir, runtimeExecFile), []byte(`{"enabled":true,"shell":"sh","token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r = collectRuntimeReport(context.Background(), dir)
	if r.Exec.Enabled || !r.Truncated {
		t.Fatal("无效配置没有关闭命令执行")
	}
}
