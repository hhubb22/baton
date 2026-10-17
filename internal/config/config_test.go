package config

import "testing"

func TestParseOriginsRejectsInsecureAndWildcard(t *testing.T) {
	for _, raw := range []string{"*", "http://baton.example", "https://user:secret@baton.example", "https://baton.example/login", ""} {
		if _, err := ParseOrigins(raw); err == nil {
			t.Fatalf("应拒绝 Origin %q", raw)
		}
	}
	got, err := ParseOrigins("https://Baton.Example:443, https://baton.example:8443")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "https://baton.example" || got[1] != "https://baton.example:8443" {
		t.Fatalf("规范结果不正确: %#v", got)
	}
}

func TestLoadServeRequiresDatabaseAndOrigins(t *testing.T) {
	env := map[string]string{}
	getenv := func(k string) string { return env[k] }
	if _, err := Load(getenv, true); err == nil {
		t.Fatal("缺少数据库配置时仍通过")
	}
	env["BATON_DATABASE_URL"] = "postgres://127.0.0.1:1/baton"
	if _, err := Load(getenv, true); err == nil {
		t.Fatal("缺少 Origin 时仍通过")
	}
	env["BATON_ALLOWED_ORIGINS"] = "http://baton.example"
	if _, err := Load(getenv, true); err == nil {
		t.Fatal("http Origin 被接受")
	}
	env["BATON_ALLOWED_ORIGINS"] = "https://baton.example"
	cfg, err := Load(getenv, true)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddr != DefaultAddr || cfg.Schema != DefaultSchema || cfg.SessionTTL != DefaultTTL {
		t.Fatalf("默认配置不正确: %+v", cfg.Redacted())
	}
}
