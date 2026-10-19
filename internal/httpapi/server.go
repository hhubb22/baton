// Package httpapi 提供员工登录、退出、本人身份、初始口令更换、节点注册、默认设备、本人节点状态、凭据吊销、任务接受和受限文件浏览。
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"baton/internal/auth"
	"baton/internal/config"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/redact"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

const maxJSONBytes = 64 << 10

// maxTaskJSONBytes 要盖住字段长度合法、但执行器输入超过 256 KiB 的任务请求。
// 这样 POST /tasks 能返回 invalid_request，而不是在读正文时被截断。
const maxTaskJSONBytes = 1 << 20

type requestIDKey struct{}

// Settings 是 API 进程使用的来源和有效期。有效期与 config 的允许范围一致。
type Settings struct {
	ProjectPreviews   ProjectPreviews
	OutputBudget      *protocol.Budget
	Origins           []string
	SessionTTL        time.Duration
	EnrollmentTTL     time.Duration
	NodeCredentialTTL time.Duration
	Signer            node.TokenSigner
	Revocations       RevocationDispatcher
	Sessions          SessionGateway
	Files             FileBrowser
	Logger            *slog.Logger
}

// RevocationDispatcher 把已保存的吊销交给当前 Gateway。尚未应用时保持 pending。
type RevocationDispatcher interface {
	DispatchRevocations(ctx context.Context) error
}

// FileBrowser 向本人节点发起一次临时文件浏览。它不把请求写入中心业务 outbox。
type FileBrowser interface {
	BrowseFiles(ctx context.Context, employeeID, nodeID string, req protocol.FileRequest) (protocol.FileResult, error)
}

// ProjectPreviews 提供已验证运行的临时文本快照。
type ProjectPreviews interface {
	ProjectPreview(string, int64) *projectagent.Preview
}

// Server 是 /api/v1 的登录与节点接口。会话 Cookie 始终带 Secure、HttpOnly 和 SameSite=Strict。
type Server struct {
	projectPreviews   ProjectPreviews
	outputBudget      *protocol.Budget
	store             *store.Store
	origins           map[string]struct{}
	ttl               time.Duration
	enrollmentTTL     time.Duration
	nodeCredentialTTL time.Duration
	signer            node.TokenSigner
	revocations       RevocationDispatcher
	sessions          SessionGateway
	browserSlots      chan struct{}
	eventInterval     time.Duration
	files             FileBrowser
	log               *slog.Logger
}

func New(pool *pgxpool.Pool, settings Settings) (*Server, error) {
	set, err := config.OriginSet(settings.Origins)
	if err != nil {
		return nil, err
	}
	if settings.SessionTTL < 5*time.Minute || settings.SessionTTL > 168*time.Hour {
		return nil, errors.New("会话有效期无效")
	}
	if settings.EnrollmentTTL < time.Minute || settings.EnrollmentTTL > 24*time.Hour {
		return nil, errors.New("注册凭据有效期无效")
	}
	if settings.NodeCredentialTTL < time.Hour || settings.NodeCredentialTTL > 90*24*time.Hour {
		return nil, errors.New("节点凭据有效期无效")
	}
	if settings.Signer == nil {
		return nil, errors.New("节点凭据签名器未配置")
	}
	logger := settings.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if settings.OutputBudget == nil {
		settings.OutputBudget = protocol.NewBudget(protocol.MaxOutputCacheBytes)
	}
	return &Server{
		store:             store.New(pool),
		projectPreviews:   settings.ProjectPreviews,
		origins:           set,
		ttl:               settings.SessionTTL,
		enrollmentTTL:     settings.EnrollmentTTL,
		nodeCredentialTTL: settings.NodeCredentialTTL,
		signer:            settings.Signer,
		revocations:       settings.Revocations,
		files:             settings.Files,
		sessions:          settings.Sessions,
		browserSlots:      make(chan struct{}, 128),
		outputBudget:      settings.OutputBudget,
		eventInterval:     time.Second,
		log:               slog.New(redact.NewHandler(logger.Handler())),
	}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, err := identity.NewUUID()
	if err != nil {
		http.Error(w, "暂时无法处理请求", http.StatusInternalServerError)
		return
	}
	w.Header().Set("X-Request-ID", id)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	sw := &statusWriter{ResponseWriter: w}
	ctx := context.WithValue(r.Context(), requestIDKey{}, id)
	defer func() {
		if recovered := recover(); recovered != nil {
			s.log.Error("panic", "request_id", id)
			if !sw.wrote {
				s.writeError(sw, r.WithContext(ctx), http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
			}
		}
		status := sw.status
		if status == 0 {
			status = http.StatusOK
		}
		s.log.Info("http", "request_id", id, "method", r.Method, "path", safePath(r.URL.Path), "status", status)
	}()
	s.route(sw, r.WithContext(ctx))
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/v1/events":
		s.events(w, r)
	case "/api/v1/login":
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.login(w, r)
	case "/api/v1/logout":
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.logout(w, r)
	case "/api/v1/me":
		if r.Method != http.MethodGet {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.me(w, r)
	case "/api/v1/me/password":
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.changePassword(w, r)
	case "/api/v1/node-enrollments":
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.issueEnrollment(w, r)
	case "/api/v1/nodes/register":
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.registerNode(w, r)
	case "/api/v1/nodes":
		if r.Method != http.MethodGet {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.listNodes(w, r)
	case "/api/v1/me/default-device", "/api/v1/me/default-pc":
		if r.Method != http.MethodPut {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.putDefaultDevice(w, r)
	case "/api/v1/tasks":
		switch r.Method {
		case http.MethodPost:
			s.createTask(w, r)
		case http.MethodGet:
			s.listTasks(w, r)
		default:
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
		}
	default:
		if r.URL.Path == "/api/v1/projects" || strings.HasPrefix(r.URL.Path, "/api/v1/projects/") {
			s.routeProject(w, r)
			return
		}
		if r.URL.Path == "/api/v1/sessions" || strings.HasPrefix(r.URL.Path, "/api/v1/sessions/") {
			s.routeSession(w, r)
			return
		}
		const taskPrefix = "/api/v1/tasks/"
		if strings.HasPrefix(r.URL.Path, taskPrefix) {
			s.routeTask(w, r)
			return
		}
		const nodePrefix = "/api/v1/nodes/"
		if strings.HasPrefix(r.URL.Path, nodePrefix) {
			rest := strings.TrimPrefix(r.URL.Path, nodePrefix)
			if strings.HasSuffix(rest, "/revoke") {
				id := strings.TrimSuffix(rest, "/revoke")
				if id == "" || strings.Contains(id, "/") {
					s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
					return
				}
				if r.Method != http.MethodPost {
					s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
					return
				}
				s.revokeNode(w, r, id)
				return
			}
			if strings.HasSuffix(rest, "/files") {
				id := strings.TrimSuffix(rest, "/files")
				if id == "" || strings.Contains(id, "/") {
					s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
					return
				}
				if r.Method != http.MethodGet {
					s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
					return
				}
				s.browseFiles(w, r, id)
				return
			}
			if rest == "" || strings.Contains(rest, "/") {
				s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
				return
			}
			if r.Method != http.MethodGet {
				s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
				return
			}
			s.getNode(w, r, rest)
			return
		}
		const prefix = "/api/v1/employees/"
		if strings.HasPrefix(r.URL.Path, prefix) {
			id := strings.TrimPrefix(r.URL.Path, prefix)
			if id == "" || strings.Contains(id, "/") {
				s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
				return
			}
			if r.Method != http.MethodGet {
				s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
				return
			}
			s.getEmployee(w, r, id)
			return
		}
		s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
	}
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.allowOrigin(w, r) {
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !s.readJSON(w, r, &body) {
		return
	}
	emp, token, csrf, expires, err := s.authenticate(r.Context(), body.Username, body.Password)
	if errors.Is(err, store.ErrInvalidCredentials) {
		s.log.Info("login rejected", "request_id", requestID(r.Context()), "code", "invalid_credentials")
		s.writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "账号或口令不正确")
		return
	}
	if err != nil {
		s.log.Error("login failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	http.SetCookie(w, auth.SessionCookie(token, expires))
	s.log.Info("login", "request_id", requestID(r.Context()), "employee_id", emp.ID)
	s.writeJSON(w, http.StatusOK, sessionResponse{
		Employee:  employeeJSON(emp),
		CSRFToken: csrf,
		ExpiresAt: expires.UTC(),
	})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !s.allowOrigin(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if !s.allowCSRF(w, r, sess.CSRFHash) {
		return
	}
	if err := s.store.RevokeSession(r.Context(), sess.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.SetCookie(w, auth.ClearSessionCookie())
			s.writeError(w, r, http.StatusUnauthorized, "unauthenticated", "登录已失效")
			return
		}
		s.log.Error("logout failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	http.SetCookie(w, auth.ClearSessionCookie())
	s.log.Info("logout", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.writeJSON(w, http.StatusOK, sessionView{
		Employee:  employeeJSON(sess.Employee),
		ExpiresAt: sess.ExpiresAt.UTC(),
	})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	if !s.allowOrigin(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if !s.allowCSRF(w, r, sess.CSRFHash) {
		return
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !s.readJSON(w, r, &body) {
		return
	}
	if err := auth.ValidatePassword(body.NewPassword, sess.Employee.Username); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_password", err.Error())
		return
	}
	if len(body.CurrentPassword) == len(body.NewPassword) &&
		subtle.ConstantTimeCompare([]byte(body.CurrentPassword), []byte(body.NewPassword)) == 1 {
		s.writeError(w, r, http.StatusBadRequest, "password_reused", "新口令不能与当前口令相同")
		return
	}
	cred, err := s.store.FindLocalCredential(r.Context(), sess.Employee.Username)
	if err != nil {
		s.log.Error("password change failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	match, err := auth.VerifyPassword(body.CurrentPassword, cred.PasswordHash)
	if err != nil {
		s.log.Error("password change failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	if !match {
		s.writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "账号或口令不正确")
		return
	}
	next, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		s.log.Error("password change failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	if err := s.store.SetLocalPassword(r.Context(), cred.Employee.ID, cred.PasswordHash, next, false); err != nil {
		if errors.Is(err, store.ErrCredentialChanged) {
			s.writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "账号或口令不正确")
			return
		}
		s.log.Error("password change failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	http.SetCookie(w, auth.ClearSessionCookie())
	cred.Employee.MustChangePassword = false
	s.log.Info("password changed", "request_id", requestID(r.Context()), "employee_id", cred.Employee.ID)
	s.writeJSON(w, http.StatusOK, sessionView{Employee: employeeJSON(cred.Employee)})
}

func (s *Server) getEmployee(w http.ResponseWriter, r *http.Request, rawID string) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, err := identity.ParseUUID(rawID)
	if err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "员工标识不正确")
		return
	}
	self, err := identity.ParseUUID(sess.Employee.ID)
	if err != nil || id != self {
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能访问其他员工的资料")
		return
	}
	s.writeJSON(w, http.StatusOK, employeeJSON(sess.Employee))
}

func (s *Server) authenticate(ctx context.Context, username, password string) (identity.Employee, string, string, time.Time, error) {
	dummy, err := auth.DummyHash()
	if err != nil {
		return identity.Employee{}, "", "", time.Time{}, err
	}
	hash := dummy
	var cred store.Credential
	found := false
	if validUsername(username) {
		loaded, err := s.store.FindLocalCredential(ctx, username)
		if err == nil {
			cred = loaded
			hash = loaded.PasswordHash
			found = true
		} else if !errors.Is(err, store.ErrNotFound) {
			return identity.Employee{}, "", "", time.Time{}, err
		}
	}
	forceFail := false
	checked := password
	if password == "" || utf8.RuneCountInString(password) > authMaxPassword {
		checked = "invalid-password"
		forceFail = true
	}
	match, err := auth.VerifyPassword(checked, hash)
	if err != nil {
		return identity.Employee{}, "", "", time.Time{}, err
	}
	if forceFail || !found || !match {
		return identity.Employee{}, "", "", time.Time{}, store.ErrInvalidCredentials
	}
	token, csrf, expires, err := s.store.InsertSession(ctx, cred.Employee.ID, cred.PasswordHash, s.ttl)
	if errors.Is(err, store.ErrCredentialChanged) {
		return identity.Employee{}, "", "", time.Time{}, store.ErrInvalidCredentials
	}
	if err != nil {
		return identity.Employee{}, "", "", time.Time{}, err
	}
	return cred.Employee, token, csrf, expires, nil
}

const authMaxPassword = 128

func validUsername(username string) bool {
	if username == "" || len(username) > 63 {
		return false
	}
	for i, r := range username {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9' && i > 0:
		case (r == '.' || r == '_' || r == '-') && i > 0:
		default:
			return false
		}
	}
	return true
}

func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) (store.Session, bool) {
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil || cookie.Value == "" || len(cookie.Value) > 200 {
		s.writeError(w, r, http.StatusUnauthorized, "unauthenticated", "登录已失效")
		return store.Session{}, false
	}
	sess, err := s.store.LookupSession(r.Context(), cookie.Value)
	if errors.Is(err, store.ErrSessionExpired) {
		s.writeError(w, r, http.StatusUnauthorized, "session_expired", "登录已过期")
		return store.Session{}, false
	}
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, r, http.StatusUnauthorized, "unauthenticated", "登录已失效")
		return store.Session{}, false
	}
	if err != nil {
		s.log.Error("session lookup failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return store.Session{}, false
	}
	return sess, true
}

func (s *Server) allowOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin, err := config.NormalizeOrigin(r.Header.Get("Origin"))
	if err != nil {
		s.writeError(w, r, http.StatusForbidden, "origin_rejected", "请求来源不被接受")
		return false
	}
	if _, ok := s.origins[origin]; !ok {
		s.writeError(w, r, http.StatusForbidden, "origin_rejected", "请求来源不被接受")
		return false
	}
	return true
}

func (s *Server) allowCSRF(w http.ResponseWriter, r *http.Request, want []byte) bool {
	got := r.Header.Get(auth.CSRFHeader)
	if len(got) < 20 || len(got) > 200 || subtle.ConstantTimeCompare(auth.Digest(got), want) != 1 {
		s.writeError(w, r, http.StatusForbidden, "csrf_rejected", "缺少有效的 CSRF 令牌")
		return false
	}
	return true
}

func (s *Server) readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	return s.readJSONLimit(w, r, dst, maxJSONBytes)
}

func (s *Server) readJSONLimit(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		s.writeError(w, r, http.StatusUnsupportedMediaType, "unsupported_media", "需要 application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "request body too large") {
			s.writeError(w, r, http.StatusRequestEntityTooLarge, "body_too_large", "请求体过大")
			return false
		}
		s.writeError(w, r, http.StatusBadRequest, "invalid_request", "请求格式不正确")
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		s.writeError(w, r, http.StatusBadRequest, "invalid_request", "请求格式不正确")
		return false
	}
	return true
}

type employeeBody struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	DisplayName        string `json:"display_name"`
	AuthSource         string `json:"auth_source"`
	MustChangePassword bool   `json:"must_change_password"`
}

type sessionResponse struct {
	Employee  employeeBody `json:"employee"`
	CSRFToken string       `json:"csrf_token"`
	ExpiresAt time.Time    `json:"expires_at"`
}

type sessionView struct {
	Employee  employeeBody `json:"employee"`
	ExpiresAt time.Time    `json:"expires_at,omitempty"`
}

func employeeJSON(emp identity.Employee) employeeBody {
	return employeeBody{
		ID:                 emp.ID,
		Username:           emp.Username,
		DisplayName:        emp.DisplayName,
		AuthSource:         emp.AuthSource,
		MustChangePassword: emp.MustChangePassword,
	}
}

type errorDetails struct {
	Fields []string `json:"fields,omitempty"`
}

type errorBody struct {
	CurrentVersion int           `json:"current_version,omitempty"`
	CurrentStatus  string        `json:"current_status,omitempty"`
	Code           string        `json:"code"`
	Message        string        `json:"message"`
	RequestID      string        `json:"request_id"`
	TaskID         string        `json:"task_id,omitempty"`
	Details        *errorDetails `json:"details,omitempty"`
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	s.writeJSON(w, status, errorBody{Code: code, Message: message, RequestID: requestID(r.Context())})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(body)
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func safePath(path string) string {
	switch path {
	case "/api/v1/login", "/api/v1/logout", "/api/v1/me", "/api/v1/me/password",
		"/api/v1/node-enrollments", "/api/v1/nodes", "/api/v1/nodes/register", "/api/v1/me/default-pc", "/api/v1/me/default-device",
		"/api/v1/tasks":
		return path
	}
	const taskPrefix = "/api/v1/tasks/"
	if strings.HasPrefix(path, taskPrefix) {
		rest := strings.TrimPrefix(path, taskPrefix)
		for _, action := range []string{"resolve", "rerun", "acceptance"} {
			if strings.HasSuffix(rest, "/"+action) {
				id := strings.TrimSuffix(rest, "/"+action)
				if id != "" && !strings.Contains(id, "/") {
					return "/api/v1/tasks/:id/" + action
				}
			}
		}
		if strings.HasSuffix(rest, "/events") {
			id := strings.TrimSuffix(rest, "/events")
			if id != "" && !strings.Contains(id, "/") {
				return "/api/v1/tasks/:id/events"
			}
		}
		if strings.HasSuffix(rest, "/cancel") {
			id := strings.TrimSuffix(rest, "/cancel")
			if id != "" && !strings.Contains(id, "/") {
				return "/api/v1/tasks/:id/cancel"
			}
		}
		if rest != "" && !strings.Contains(rest, "/") {
			return "/api/v1/tasks/:id"
		}
	}
	const nodePrefix = "/api/v1/nodes/"
	if strings.HasPrefix(path, nodePrefix) {
		rest := strings.TrimPrefix(path, nodePrefix)
		if strings.HasSuffix(rest, "/revoke") {
			id := strings.TrimSuffix(rest, "/revoke")
			if id != "" && !strings.Contains(id, "/") {
				return "/api/v1/nodes/:id/revoke"
			}
		}
		if strings.HasSuffix(rest, "/files") {
			id := strings.TrimSuffix(rest, "/files")
			if id != "" && !strings.Contains(id, "/") {
				return "/api/v1/nodes/:id/files"
			}
		}
		if rest != "" && !strings.Contains(rest, "/") {
			return "/api/v1/nodes/:id"
		}
	}
	const prefix = "/api/v1/employees/"
	if strings.HasPrefix(path, prefix) {
		rest := strings.TrimPrefix(path, prefix)
		if rest != "" && !strings.Contains(rest, "/") {
			return "/api/v1/employees/:id"
		}
	}
	return "unmatched"
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.status = status
	w.wrote = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// SetEventIntervalForTest 在启动服务前调整测试采样间隔，便于验证传输反压。
func (s *Server) SetEventIntervalForTest(interval time.Duration) { s.eventInterval = interval }

// BrowserConnectionsForTest 返回当前占用的浏览器连接名额。
func (s *Server) BrowserConnectionsForTest() int { return len(s.browserSlots) }
