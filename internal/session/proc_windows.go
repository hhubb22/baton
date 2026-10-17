//go:build windows

package session

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createBreakawayFromJob = 0x01000000

func startWorkerProcess(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createBreakawayFromJob,
	}
	if err := cmd.Start(); err == nil {
		return cmd, nil
	}
	cmd = newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

// holdAgentJob 让 Worker 持有 Job Object。后续 Agent 进程放进这个 Job，batond 退出不会连带结束 Worker。
func holdAgentJob() (func(), error) {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	return func() { _ = windows.CloseHandle(handle) }, nil
}
