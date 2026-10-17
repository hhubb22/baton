package redact

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestScrubRemovesConnectionSecrets(t *testing.T) {
	in := "dial postgres://app:s3cret@127.0.0.1:5432/baton failed password=s3cret baton_session=abc csrf_token=def"
	out := Scrub(in)
	if strings.Contains(out, "s3cret") || strings.Contains(out, "abc") || strings.Contains(out, "def") {
		t.Fatalf("脱敏后仍有敏感片段: %s", out)
	}
	if !strings.Contains(out, "postgres://[redacted]") || !strings.Contains(out, "password=[redacted]") {
		t.Fatalf("脱敏结果缺少占位: %s", out)
	}
}

func TestHandlerRedactsAttributes(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(NewHandler(slog.NewTextHandler(&buf, nil)))
	logger.Error("login",
		"password", "plain-secret",
		"csrf_token", "csrf-secret",
		"cookie", "baton_session=session-secret",
		"err", errors.New("password=plain-secret"),
		"employee_id", "emp-1",
	)
	out := buf.String()
	if strings.Contains(out, "plain-secret") || strings.Contains(out, "csrf-secret") || strings.Contains(out, "session-secret") {
		t.Fatalf("日志仍含敏感字段")
	}
	if !strings.Contains(out, "employee_id=emp-1") && !strings.Contains(out, "employee_id") {
		t.Fatalf("日志缺少员工标识: %s", out)
	}
}
