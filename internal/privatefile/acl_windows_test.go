package privatefile_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"baton/internal/privatefile"
	"baton/internal/privatefiletest"

	"golang.org/x/sys/windows"
)

func userSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

func setDACL(t *testing.T, path, sddl string, protection windows.SECURITY_INFORMATION) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|protection, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsUnsafeWindowsDACL(t *testing.T) {
	userACE := "(A;;FA;;;" + userSID(t) + ")"
	for name, other := range map[string]string{
		"everyone_read":  "(A;;FR;;;WD)",
		"everyone_write": "(A;;FW;;;WD)",
		"users_read":     "(A;;FR;;;BU)",
		"administrators": "(A;;FA;;;BA)",
		"system":         "(A;;FA;;;SY)",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "secret")
			if err := privatefile.WriteFile(path, []byte("secret")); err != nil {
				t.Fatal(err)
			}
			setDACL(t, path, "D:P"+userACE+other, windows.PROTECTED_DACL_SECURITY_INFORMATION)
			if _, err := privatefile.ReadFile(path); err == nil {
				t.Fatal("接受了其他主体有访问权限的 DACL")
			}
		})
	}
	t.Run("null_dacl", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "secret")
		if err := privatefile.WriteFile(path, []byte("secret")); err != nil {
			t.Fatal(err)
		}
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, nil, nil); err != nil {
			t.Fatal(err)
		}
		if _, err := privatefile.ReadFile(path); err == nil {
			t.Fatal("接受了 NULL DACL")
		}
	})
}

func TestRejectsInheritedWindowsDACL(t *testing.T) {
	dir := t.TempDir()
	setDACL(t, dir, "D:P(A;OICI;FA;;;"+userSID(t)+")(A;OICI;FR;;;WD)", windows.PROTECTED_DACL_SECURITY_INFORMATION)
	path := filepath.Join(dir, "inherited")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		t.Fatalf("没有构造出继承 DACL: %v", err)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, 0, &ace); err != nil || ace.Header.AceFlags&windows.INHERITED_ACE == 0 {
		t.Fatalf("没有构造出继承 ACE: %v", err)
	}
	if _, err := privatefile.ReadFile(path); err == nil {
		t.Fatal("接受了继承的宽松 DACL")
	}
	// 同一宽松父目录中新建文件不能继承它的 ACL。
	secure := filepath.Join(dir, "protected")
	if err := privatefile.WriteFile(secure, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	privatefiletest.AssertPrivate(t, secure)
	if _, err := privatefile.ReadFile(secure); err != nil {
		t.Fatal(err)
	}
	setDACL(t, secure, "D:"+"(A;;FA;;;"+userSID(t)+")", windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if _, err := privatefile.ReadFile(secure); err == nil {
		t.Fatal("接受了未禁止继承的 DACL")
	}
}

func TestRejectsWindowsJunction(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(target, "secret")
	if err := privatefile.WriteFile(path, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(dir, "junction")
	if output, err := exec.Command("cmd.exe", "/c", "mklink", "/J", junction, target).CombinedOutput(); err != nil {
		t.Fatalf("无法创建 junction: %v: %s", err, output)
	}
	name, err := windows.UTF16PtrFromString(junction)
	if err != nil {
		t.Fatal(err)
	}
	attrs, err := windows.GetFileAttributes(name)
	if err != nil || attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		t.Fatalf("夹具不是 reparse point: %v", err)
	}
	if _, err := privatefile.ReadFile(filepath.Join(junction, "secret")); err == nil {
		t.Fatal("经 junction 读取了秘密")
	}
	if err := privatefile.WriteFile(filepath.Join(junction, "new"), []byte("secret")); err == nil {
		t.Fatal("经 junction 写入了秘密")
	}
	if err := privatefile.ProtectDir(junction); err == nil {
		t.Fatal("接受了 junction 数据目录")
	}
}
