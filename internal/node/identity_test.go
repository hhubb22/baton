package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/auth"
	"baton/internal/identity"
)

func TestIdentityFileSurvivesReloadAndRejectsLoosePermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	ident := sampleIdentity(t)
	if err := WriteIdentity(dir, ident); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("身份文件权限是 %o", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("数据目录权限是 %o", dirInfo.Mode().Perm())
	}
	got, err := ReadIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != ident.NodeID || got.Credential.Token != ident.Credential.Token || got.RegistrationSeq != ident.RegistrationSeq {
		t.Fatal("重新读取的身份发生变化")
	}
	if strings.Contains(FormatPublic(got), ident.Credential.Token) {
		t.Fatal("公开摘要包含连接凭据")
	}
	if err := os.Chmod(filepath.Join(dir, IdentityFileName), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = ReadIdentity(dir)
	if err == nil || strings.Contains(err.Error(), ident.Credential.Token) {
		t.Fatal("权限过宽的身份文件仍被读取，或错误包含凭据")
	}
}

func TestDataDirFollowsPlatformConvention(t *testing.T) {
	got, err := dataDir("darwin", func(string) string { return "" }, "/Users/ada")
	if err != nil || got != filepath.Join("/Users/ada", "Library", "Application Support", "baton", "node") {
		t.Fatalf("macOS 目录 %s %v", got, err)
	}
	got, err = dataDir("linux", func(string) string { return "" }, "/home/ada")
	if err != nil || got != filepath.Join("/home/ada", ".local", "share", "baton", "node") {
		t.Fatalf("Linux 目录 %s %v", got, err)
	}
	got, err = dataDir("linux", func(k string) string {
		if k == "XDG_DATA_HOME" {
			return "/var/data"
		}
		return ""
	}, "/home/ada")
	if err != nil || got != filepath.Join("/var/data", "baton", "node") {
		t.Fatalf("XDG 目录 %s %v", got, err)
	}
	base := `C:\Users\ada\AppData\Local`
	got, err = dataDir("windows", func(k string) string {
		if k == "LOCALAPPDATA" {
			return base
		}
		return ""
	}, "")
	if err != nil || got != filepath.Join(base, "baton", "node") {
		t.Fatalf("Windows 目录 %s %v", got, err)
	}
}

func TestValidateRejectsRoleAndDuplicateCapability(t *testing.T) {
	if err := Validate("Desk", SystemLinux, "root", nil); err == nil {
		t.Fatal("未知角色被接受")
	}
	if err := Validate("Desk", SystemLinux, RolePC, []string{"start", "start"}); err == nil {
		t.Fatal("重复能力被接受")
	}
	if err := Validate("Desk", SystemLinux, RolePC, []string{"Start"}); err == nil {
		t.Fatal("大写能力名称被接受")
	}
}

func sampleIdentity(t *testing.T) Identity {
	t.Helper()
	token, err := auth.NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	employeeID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	credentialID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return Identity{
		NodeID:          nodeID,
		EmployeeID:      employeeID,
		DisplayName:     "Desk",
		System:          SystemLinux,
		Role:            RolePC,
		Capabilities:    []string{"start"},
		RegistrationSeq: 1,
		RegisteredAt:    time.Now().UTC(),
		Credential: Credential{
			ID:        credentialID,
			Version:   1,
			Token:     token,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	}
}
