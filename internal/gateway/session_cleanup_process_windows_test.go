//go:build windows

package gateway_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func sessionWorkerStarting(ctx context.Context, dataDir, sessionID string) (bool, error) {
	commands, err := sessionCleanupCommands(dataDir, sessionID)
	if err != nil {
		return false, err
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		candidate := false
		for _, args := range commands {
			if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(args[0])) {
				candidate = true
				break
			}
		}
		if !candidate {
			continue
		}
		found, err := sessionWorkerCommandMatches(entry.ProcessID, commands)
		if err != nil || found {
			return found, err
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return false, err
	}
	return false, nil
}

func sessionWorkerCommandMatches(pid uint32, commands [][]string) (bool, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("打开测试 Worker 候选进程 %d: %w", pid, err)
	}
	defer windows.CloseHandle(process)
	image := make([]uint16, 32768)
	size := uint32(len(image))
	if err := windows.QueryFullProcessImageName(process, 0, &image[0], &size); err != nil {
		if state, _ := windows.WaitForSingleObject(process, 0); state == windows.WAIT_OBJECT_0 {
			return false, nil
		}
		return false, err
	}
	name := windows.UTF16ToString(image[:size])
	candidate := false
	for _, args := range commands {
		candidate = candidate || sameExecutable(name, args[0])
	}
	if !candidate {
		return false, nil
	}
	args, err := sessionWorkerArguments(process)
	if err != nil {
		if state, _ := windows.WaitForSingleObject(process, 0); state == windows.WAIT_OBJECT_0 {
			return false, nil
		}
		return false, fmt.Errorf("读取测试 Worker 候选进程 %d 参数: %w", pid, err)
	}
	for _, want := range commands {
		if len(args) == len(want) && sameExecutable(args[0], want[0]) && slices.Equal(args[1:], want[1:]) {
			return true, nil
		}
	}
	return false, nil
}

// ProcessCommandLineInformation 直接读取本地进程参数，不依赖 WMI 或 PowerShell。
func sessionWorkerArguments(process windows.Handle) ([]string, error) {
	var size uint32
	_ = windows.NtQueryInformationProcess(process, windows.ProcessCommandLineInformation, nil, 0, &size)
	if size < uint32(unsafe.Sizeof(windows.NTUnicodeString{})) || size > 1<<20 {
		return nil, errors.New("Worker 命令行缓冲区大小无效")
	}
	buf := make([]byte, size)
	if err := windows.NtQueryInformationProcess(process, windows.ProcessCommandLineInformation, unsafe.Pointer(&buf[0]), size, &size); err != nil {
		return nil, err
	}
	value := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
	base, pointer := uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(value.Buffer))
	if value.Length%2 != 0 || pointer < base || pointer+uintptr(value.Length) > base+uintptr(len(buf)) {
		return nil, errors.New("Worker 命令行缓冲区内容无效")
	}
	command := windows.UTF16ToString(unsafe.Slice(value.Buffer, int(value.Length/2)))
	runtime.KeepAlive(buf)
	return windows.DecomposeCommandLine(command)
}
