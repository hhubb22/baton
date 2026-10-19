//go:build unix

package replay

import (
	"os"
	"os/signal"
	"syscall"
)

func forwardRecordSignals(process *os.Process) func() {
	signals := make(chan os.Signal, 2)
	done := make(chan struct{})
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		for {
			select {
			case s := <-signals:
				_ = process.Signal(s)
			case <-done:
				return
			}
		}
	}()
	return func() { signal.Stop(signals); close(done) }
}

func recordExit(state *os.ProcessState) Exit {
	status := state.Sys().(syscall.WaitStatus)
	if status.Signaled() {
		s := status.Signal()
		name := map[syscall.Signal]string{syscall.SIGTERM: "SIGTERM", syscall.SIGINT: "SIGINT", syscall.SIGKILL: "SIGKILL", syscall.SIGPIPE: "SIGPIPE"}[s]
		if name == "" {
			name = s.String()
		}
		return Exit{Code: 128 + int(s), Signal: name}
	}
	return Exit{Code: state.ExitCode()}
}
