package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStdioFramingAndLimits(t *testing.T) {
	for _, test := range []struct {
		input string
		ok    bool
	}{
		{`{"id":1,"request":{"operation":"probe"}}` + "\n", true},
		{`{"id":1,"request":{}} {}` + "\n", false},
		{`{"id":0,"request":{}}` + "\n", false},
		{strings.Repeat("x", MaxFrame+1) + "\n", false},
		{"{\"id\":1,\"request\":\"\xff\"}\n", false},
	} {
		var out bytes.Buffer
		err := Serve(context.Background(), strings.NewReader(test.input), &out, func(_ context.Context, r json.RawMessage) any { return map[string]any{"ok": true, "echo": r} })
		if (err == nil) != test.ok {
			t.Fatalf("帧结果不符: %v", err)
		}
		if test.ok && !strings.Contains(out.String(), `"id":1`) {
			t.Fatal("响应编号丢失")
		}
	}
}

func TestBundleRejectsIncompatibleManifest(t *testing.T) {
	dir := t.TempDir()
	bundle := filepath.Join(dir, "sidecars", "project-agent")
	if err := os.MkdirAll(bundle, 0700); err != nil {
		t.Fatal(err)
	}
	for _, m := range []Manifest{
		{Name: "project-agent", Version: "old", Protocol: 1, Entry: "index.js"},
		{Name: "project-agent", Version: "0.1.0", Protocol: 2, Entry: "index.js"},
		{Name: "project-agent", Version: "0.1.0", Protocol: 1, Entry: "../outside.js"},
	} {
		raw, _ := json.Marshal(m)
		if err := os.WriteFile(filepath.Join(bundle, "manifest.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := commandAt(context.Background(), dir, "project-agent", "0.1.0", "missing"); err == nil {
			t.Fatal("接受了不兼容 bundle")
		}
	}
}
func TestNodeMinimumVersion(t *testing.T) {
	for _, test := range []struct {
		version string
		ok      bool
	}{{"v22.19.0", true}, {"v24.0.0", true}, {"v22.18.0", false}, {"v20.0.0", false}, {"invalid", false}} {
		if supportedNode(test.version) != test.ok {
			t.Fatal(test.version)
		}
	}
}

func TestNodeStdioUsesManagedProcessTree(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("未安装 Node.js")
	}
	script := filepath.Join(t.TempDir(), "echo.cjs")
	if err = os.WriteFile(script, []byte(`process.stdout.write(JSON.stringify({id:1,request:{operation:'hello'}})+'\n');
process.stdin.once('data',data=>{const r=JSON.parse(data);process.exit(r.id===1&&r.result.ok===true?0:2)});`), 0600); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	cmd := exec.Command(node, script)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	var requests atomic.Int32
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	stop, err := StartTree(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, output, input, func(_ context.Context, r json.RawMessage) any {
			requests.Add(1)
			return map[string]bool{"ok": bytes.Contains(r, []byte("hello"))}
		})
	}()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		stop()
		waitErr := <-exited
		t.Fatalf("Node stdio 未退出: requests=%d node=%s wait=%v stderr=%s", requests.Load(), node, waitErr, stderr.String())
	}
	<-done
	t.Logf("Node stdio 完成: requests=%d elapsed=%s", requests.Load(), time.Since(started))
}

func TestPrivateFileUsesNativePermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "credentials")
	if err := PrivateFile([]string{"protect-dir", dir}, nil, nil); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "provider.json")
	if err := PrivateFile([]string{"write", dir, file}, strings.NewReader(`{"access":"fixture"}`), nil); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := PrivateFile([]string{"read", dir, file}, nil, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != `{"access":"fixture"}` {
		t.Fatal("凭据没有原样往返")
	}
	if err := PrivateFile([]string{"write", dir, filepath.Join(dir, "..", "escaped.json")}, strings.NewReader("secret"), nil); err == nil {
		t.Fatal("允许凭据越过私有目录")
	}
}

func TestBoundedOutputCapsMemory(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := &boundedOutput{limit: 16 << 10, cancel: cancel}
	raw := bytes.Repeat([]byte("x"), 1<<20)
	n, err := b.Write(raw)
	if err != nil || n != len(raw) || b.Len() != 16<<10 || !b.overflow || ctx.Err() == nil {
		t.Fatal("输出超限没有限制容量并取消进程")
	}
}
