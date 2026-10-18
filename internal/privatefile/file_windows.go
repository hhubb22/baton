package privatefile

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errPermissions = errors.New("秘密文件无效或访问控制过宽")

func currentUser() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid, nil
}

func descriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	user, err := currentUser()
	if err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:" + user.String() + "D:P(A;;FA;;;" + user.String() + ")")
}

// checkPath 也拒绝祖先目录中的 junction 和其他 reparse point。
func checkPath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for {
		name, err := windows.UTF16PtrFromString(abs)
		if err != nil {
			return err
		}
		attrs, err := windows.GetFileAttributes(name)
		if err != nil {
			return err
		}
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("秘密路径不能包含 reparse point")
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return nil
		}
		abs = parent
	}
}

func openHandle(path string, access uint32) (windows.Handle, error) {
	if err := checkPath(path); err != nil {
		return windows.InvalidHandle, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	h, err := windows.CreateFile(name, access|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return h, err
	}
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err == nil && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		err = errors.New("秘密路径不能包含 reparse point")
	}
	if err != nil {
		windows.CloseHandle(h)
		return windows.InvalidHandle, err
	}
	return h, nil
}

func checkACL(h windows.Handle) error {
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errPermissions
	}
	user, err := currentUser()
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !windows.EqualSid(owner, user) {
		return errPermissions
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return errPermissions
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERITED_ACE != 0 {
			return errPermissions
		}
		switch ace.Header.AceType {
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if !windows.EqualSid(sid, user) {
				return errPermissions
			}
		case windows.ACCESS_DENIED_ACE_TYPE:
		default:
			return errPermissions
		}
	}
	return nil
}

// Open 对实际读取的句柄检查 DACL，检查期间禁止写入和替换文件。
func Open(path string) (*os.File, error) {
	h, err := openHandle(path, windows.GENERIC_READ|windows.READ_CONTROL)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), path)
	info, err := f.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errPermissions
	}
	if err == nil {
		err = checkACL(h)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// CreateTemp 在创建时设置 DACL，秘密写入前不暴露继承权限窗口。
func CreateTemp(dir, prefix string) (*os.File, error) {
	if err := checkPath(dir); err != nil {
		return nil, err
	}
	sd, err := descriptor()
	if err != nil {
		return nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for i := 0; i < 100; i++ {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, err
		}
		path := filepath.Join(dir, prefix+hex.EncodeToString(random[:]))
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return nil, err
		}
		h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, &sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if errors.Is(err, windows.ERROR_FILE_EXISTS) || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return os.NewFile(uintptr(h), path), nil
	}
	return nil, errors.New("无法创建秘密临时文件")
}

func ProtectDir(path string) error {
	h, err := openHandle(path, windows.GENERIC_READ|windows.WRITE_DAC|windows.WRITE_OWNER)
	if err != nil {
		return fmt.Errorf("保护目录打开失败: %w", err)
	}
	defer windows.CloseHandle(h)
	sd, err := descriptor()
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, nil, acl, nil); err != nil {
		return fmt.Errorf("保护目录设置失败: %w", err)
	}
	return nil
}

func CheckDir(path string) error {
	h, err := openHandle(path, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errPermissions
	}
	return checkACL(h)
}
