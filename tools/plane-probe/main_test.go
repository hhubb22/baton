package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunMatchDoesNotPrintSecret(t *testing.T) {
	dir := t.TempDir()
	bodyPath := filepath.Join(dir, "body.json")
	body := []byte(`{"event":"issue","name":"\u63a2\u9488"}`)
	if err := os.WriteFile(bodyPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	const secret = "example-webhook-secret"
	var stdout, stderr bytes.Buffer
	err := run(
		[]string{"-body", bodyPath, "-signature", "e2ed972d1c71a2e477bb61f5a868db33e025ee9dff5d52cbc8e55e100a4fe3da"},
		func(key string) string {
			if key == "PLANE_WEBHOOK_SECRET" {
				return secret
			}
			return ""
		},
		&stdout,
		&stderr,
	)
	if err != nil {
		t.Fatalf("校验失败: %v stderr=%s", err, stderr.String())
	}
	if stdout.String() != "match=true\n" {
		t.Fatalf("输出 %q", stdout.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) {
		t.Fatal("输出包含密钥")
	}
}

func TestRunMismatch(t *testing.T) {
	dir := t.TempDir()
	bodyPath := filepath.Join(dir, "body.json")
	if err := os.WriteFile(bodyPath, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := run([]string{"-body", bodyPath, "-signature", "514097be26dd10bd804a0f47c9dc98bfd6ee325b9fe66a595e5ee56cc7243855"}, func(string) string {
		return "example-webhook-secret"
	}, &stdout, &stderr)
	if err == nil {
		t.Fatal("错误签名应失败")
	}
	if stdout.String() != "match=false\n" {
		t.Fatalf("输出 %q", stdout.String())
	}
}
