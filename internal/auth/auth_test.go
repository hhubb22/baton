package auth

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashIsArgon2id(t *testing.T) {
	const password = "plain-password-should-not-be-stored-001"
	encoded, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encoded, password) {
		t.Fatal("摘要包含明文口令")
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("摘要参数不正确: %s", encoded)
	}
	ok, err := VerifyPassword(password, encoded)
	if err != nil || !ok {
		t.Fatalf("正确口令未通过校验: %v %v", ok, err)
	}
	ok, err = VerifyPassword(password+"x", encoded)
	if err != nil || ok {
		t.Fatalf("错误口令被接受: %v %v", ok, err)
	}
	other, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if other == encoded {
		t.Fatal("相同口令不应生成相同摘要")
	}
	if _, err := VerifyPassword(password, "plaintext"); err == nil {
		t.Fatal("损坏的摘要被当作普通失败")
	}
}

func TestPasswordPolicy(t *testing.T) {
	if err := ValidatePassword("short-1", "alice"); err == nil {
		t.Fatal("过短口令被接受")
	}
	if err := ValidatePassword("alice-username", "alice-username"); err == nil {
		t.Fatal("与用户名相同的口令被接受")
	}
	if err := ValidatePassword("  long-enough-1", "alice"); err == nil {
		t.Fatal("带首尾空格的口令被接受")
	}
	if err := ValidatePassword("long-enough-1", "alice"); err != nil {
		t.Fatal(err)
	}
}

func TestGeneratedPasswordMeetsPolicy(t *testing.T) {
	password, err := GeneratePassword()
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidatePassword(password, "alice"); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(password, "-_ \n") {
		t.Fatal("生成口令包含未约定字符")
	}
}

func TestSessionCookieIsAlwaysSecure(t *testing.T) {
	cookie := SessionCookie("token-value", time.Now().Add(time.Hour))
	if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("Cookie 标志不正确: secure=%v httponly=%v samesite=%v", cookie.Secure, cookie.HttpOnly, cookie.SameSite)
	}
	header := cookie.String()
	for _, want := range []string{"baton_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(header, want) {
			t.Fatalf("Cookie 缺少 %s: %s", want, header)
		}
	}
	if strings.Contains(strings.ToLower(header), "domain=") {
		t.Fatalf("Cookie 不应指定 Domain: %s", header)
	}
	cleared := ClearSessionCookie().String()
	if !strings.Contains(cleared, "HttpOnly") || !strings.Contains(cleared, "Secure") || !strings.Contains(cleared, "SameSite=Strict") {
		t.Fatalf("清除 Cookie 属性不完整: %s", cleared)
	}
}
