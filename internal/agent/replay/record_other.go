//go:build !unix

package replay

import "os"

// Windows 只保留退出码，平台不支持 Unix 信号转发。
func forwardRecordSignals(*os.Process) func() { return func() {} }
func recordExit(state *os.ProcessState) Exit  { return Exit{Code: state.ExitCode()} }
