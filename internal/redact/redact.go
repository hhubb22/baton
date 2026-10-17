// Package redact 去掉日志和错误文本中的连接串、口令参数与会话 Cookie。
package redact

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
)

var (
	uriPattern        = regexp.MustCompile(`(?i)\bpostgres(?:ql)?://\S+`)
	kvPattern         = regexp.MustCompile(`(?i)\b(password|sslpassword|token|secret)=([^\s]+)`)
	cookiePattern     = regexp.MustCompile(`(?i)\bbaton_session=[^;\s]+`)
	csrfPattern       = regexp.MustCompile(`(?i)\bcsrf_token=[^;\s&]+`)
	bearerPattern     = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._=-]+`)
	enrollmentPattern = regexp.MustCompile(`(?i)\benrollment_token=[^;\s&]+`)
	connectionPattern = regexp.MustCompile(`(?i)\bconnection_token=[^;\s&]+`)
	jwtPattern        = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
)

// Scrub 替换连接串、口令参数和会话 Cookie。输入不是这些内容时原样返回。
func Scrub(s string) string {
	s = uriPattern.ReplaceAllString(s, "postgres://[redacted]")
	s = kvPattern.ReplaceAllString(s, "$1=[redacted]")
	s = cookiePattern.ReplaceAllString(s, "baton_session=[redacted]")
	s = csrfPattern.ReplaceAllString(s, "csrf_token=[redacted]")
	s = bearerPattern.ReplaceAllString(s, "bearer [redacted]")
	s = enrollmentPattern.ReplaceAllString(s, "enrollment_token=[redacted]")
	s = connectionPattern.ReplaceAllString(s, "connection_token=[redacted]")
	s = jwtPattern.ReplaceAllString(s, "[redacted]")
	return s
}

var sensitiveKeys = map[string]struct{}{
	"password":         {},
	"current_password": {},
	"new_password":     {},
	"token":            {},
	"session":          {},
	"session_token":    {},
	"csrf":             {},
	"csrf_token":       {},
	"cookie":           {},
	"set_cookie":       {},
	"authorization":    {},
	"secret":           {},
	"password_hash":    {},
	"database_url":     {},
	"dsn":              {},
	"enrollment_token": {},
	"connection_token": {},
	"credential_token": {},
	"node_token":       {},
	"control_token":    {},
	"signing_key":      {},
}

// Handler 在写入下一级日志前去掉敏感字段。
type Handler struct {
	next slog.Handler
}

func NewHandler(next slog.Handler) *Handler {
	return &Handler{next: next}
}

func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	nr := slog.NewRecord(r.Time, r.Level, Scrub(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool {
		nr.AddAttrs(redactAttr(a))
		return true
	})
	return h.next.Handle(ctx, nr)
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	cleaned := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		cleaned[i] = redactAttr(a)
	}
	return &Handler{next: h.next.WithAttrs(cleaned)}
}

func (h *Handler) WithGroup(name string) slog.Handler {
	return &Handler{next: h.next.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	a.Value = a.Value.Resolve()
	if sensitiveKey(a.Key) {
		return slog.String(a.Key, "[redacted]")
	}
	switch a.Value.Kind() {
	case slog.KindString:
		return slog.String(a.Key, Scrub(a.Value.String()))
	case slog.KindAny:
		if err, ok := a.Value.Any().(error); ok {
			return slog.String(a.Key, Scrub(err.Error()))
		}
	case slog.KindGroup:
		group := a.Value.Group()
		cleaned := make([]slog.Attr, len(group))
		for i, g := range group {
			cleaned[i] = redactAttr(g)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(cleaned...)}
	}
	return a
}

func sensitiveKey(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(key, "-", "_"))
	_, ok := sensitiveKeys[key]
	return ok
}
