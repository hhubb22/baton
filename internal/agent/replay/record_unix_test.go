//go:build unix

package replay

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRecordSignalChild(t *testing.T) {
	if os.Getenv("BATON_RECORD_SIGNAL_CHILD") != "1" {
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	fmt.Fprintln(os.Stdout, "ready")
	s := <-signals
	if s == syscall.SIGTERM {
		os.Exit(42)
	}
	os.Exit(43)
}

func TestRecordSignalWrapper(t *testing.T) {
	path := os.Getenv("BATON_RECORD_SIGNAL_CONFIG")
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		os.Exit(1)
	}
	var c RecordConfig
	if json.Unmarshal(data, &c) != nil {
		os.Exit(1)
	}
	os.Setenv("BATON_RECORD_SIGNAL_CHILD", "1")
	exit, err := Record(context.Background(), c, []string{"-test.run=^TestRecordSignalChild$"}, os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(exit.Code)
}

func TestRecordForwardsSignals(t *testing.T) {
	for _, tc := range []struct {
		signal syscall.Signal
		code   int
	}{{syscall.SIGTERM, 42}, {syscall.SIGINT, 43}} {
		t.Run(tc.signal.String(), func(t *testing.T) {
			c := recordConfig(t)
			config := filepath.Join(t.TempDir(), "config.json")
			data, _ := json.Marshal(c)
			os.WriteFile(config, data, 0600)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, c.AgentBinary, "-test.run=^TestRecordSignalWrapper$")
			cmd.Env = append(os.Environ(), "BATON_RECORD_SIGNAL_CONFIG="+config)
			out, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { cmd.Process.Kill(); cmd.Wait() }()
			line, err := bufio.NewReader(out).ReadString('\n')
			if err != nil || line != "ready\n" {
				t.Fatalf("子进程未就绪: %q %v", line, err)
			}
			if err := cmd.Process.Signal(tc.signal); err != nil {
				t.Fatal(err)
			}
			if err := cmd.Wait(); err == nil {
				t.Fatal("未保持子进程退出码")
			} else if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != tc.code {
				t.Fatal(err)
			}
			raw := readRecording(t, c)
			if last := raw.Entries[len(raw.Entries)-1]; last.Code != tc.code {
				t.Fatal(last)
			}
		})
	}
}

func TestRecordExitSignal(t *testing.T) {
	c := exec.Command("sh", "-c", "kill -TERM $$")
	if err := c.Run(); err == nil {
		t.Fatal("未被信号终止")
	}
	if exit := recordExit(c.ProcessState); exit.Code != 143 || exit.Signal != "SIGTERM" {
		t.Fatal(exit)
	}
}
