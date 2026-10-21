//go:build windows

package session

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// killThreadChildren 把当前 Worker 的 Agent 后代加入独立 Job 后终止整个 Job。
func killThreadChildren() (bool, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	type process struct{ pid, parent uint32 }
	var all []process
	err = windows.Process32First(snapshot, &entry)
	for err == nil {
		all = append(all, process{entry.ProcessID, entry.ParentProcessID})
		err = windows.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return false, err
	}
	owned := map[uint32]bool{uint32(os.Getpid()): true}
	var children []uint32
	for changed := true; changed; {
		changed = false
		for _, p := range all {
			if owned[p.parent] && !owned[p.pid] {
				owned[p.pid] = true
				children = append(children, p.pid)
				changed = true
			}
		}
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(job)
	var handles []windows.Handle
	defer func() {
		for _, h := range handles {
			windows.CloseHandle(h)
		}
	}()
	for _, pid := range children {
		h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			return false, err
		}
		handles = append(handles, h)
		if err := windows.AssignProcessToJobObject(job, h); err != nil {
			state, waitErr := windows.WaitForSingleObject(h, 0)
			if waitErr != nil || state != windows.WAIT_OBJECT_0 {
				return false, err
			}
		}
	}
	if err := windows.TerminateJobObject(job, 1); err != nil {
		return false, err
	}
	for _, h := range handles {
		state, err := windows.WaitForSingleObject(h, 2000)
		if err != nil {
			return false, err
		}
		if state != windows.WAIT_OBJECT_0 {
			return false, nil
		}
	}
	return true, nil
}
