package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) browseFiles(w http.ResponseWriter, r *http.Request, rawID string) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "节点标识不正确")
		return
	}
	rootID, relPath, cursor, ok := s.fileQuery(w, r)
	if !ok {
		return
	}
	view, err := s.store.OwnNode(r.Context(), sess.Employee.ID, rawID)
	if errors.Is(err, store.ErrSyncRejected) {
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能查看该节点")
		return
	}
	if err != nil {
		s.log.Error("file browse failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	if view.Revoked {
		s.writeError(w, r, http.StatusConflict, "revoked", "该节点已吊销，不能浏览文件")
		return
	}
	if !view.Online {
		s.writeError(w, r, http.StatusConflict, "node_offline", "节点离线，不能浏览文件")
		return
	}
	if s.files == nil {
		s.writeError(w, r, http.StatusServiceUnavailable, "node_unavailable", "节点暂时不可达")
		return
	}
	operationID, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, http.StatusServiceUnavailable, "node_unavailable", "节点暂时不可达")
		return
	}
	result, err := s.files.BrowseFiles(r.Context(), sess.Employee.ID, view.ID, protocol.FileRequest{
		Type:        protocol.BodyFileBrowse,
		OperationID: operationID,
		RootID:      rootID,
		Path:        relPath,
		Cursor:      cursor,
	})
	if err != nil {
		s.log.Info("file browse unreachable", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", view.ID, "operation_id", operationID)
		s.writeError(w, r, http.StatusServiceUnavailable, "node_unavailable", "节点暂时不可达")
		return
	}
	if result.OperationID != operationID {
		s.log.Info("file browse rejected", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", view.ID, "operation_id", operationID, "code", "unavailable")
		s.writeError(w, r, http.StatusServiceUnavailable, "node_unavailable", "节点暂时不可达")
		return
	}
	if !result.OK {
		result.Content = nil
		status, code, message := fileError(result.Code, result.Message)
		s.log.Info("file browse rejected", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", view.ID, "operation_id", operationID, "code", code)
		s.writeError(w, r, status, code, message)
		return
	}
	if err := sanitizeFileResult(&result); err != nil {
		s.log.Info("file browse rejected", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", view.ID, "operation_id", operationID, "code", protocol.FileCodeNotText)
		s.writeError(w, r, http.StatusUnsupportedMediaType, protocol.FileCodeNotText, "只能预览文本，不能通过浏览接口读取该文件")
		return
	}
	s.log.Info("file browse", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", view.ID, "operation_id", operationID, "kind", result.Kind, "truncated", result.Truncated)
	s.writeJSON(w, http.StatusOK, fileView{
		OperationID: result.OperationID,
		NodeID:      view.ID,
		Kind:        result.Kind,
		RootID:      result.RootID,
		Path:        result.Path,
		Roots:       result.Roots,
		Entries:     result.Entries,
		Content:     result.Content,
		Size:        result.Size,
		Truncated:   result.Truncated,
		Remainder:   result.Remainder,
		NextCursor:  result.NextCursor,
	})
}

func (s *Server) fileQuery(w http.ResponseWriter, r *http.Request) (string, string, string, bool) {
	query := r.URL.Query()
	for key, values := range query {
		switch key {
		case "root_id", "path", "cursor":
			if len(values) > 1 {
				s.writeError(w, r, http.StatusBadRequest, "invalid_request", "路径不正确")
				return "", "", "", false
			}
		default:
			s.writeError(w, r, http.StatusBadRequest, "invalid_request", "路径不正确")
			return "", "", "", false
		}
	}
	rootID := query.Get("root_id")
	relPath := query.Get("path")
	cursor := query.Get("cursor")
	if err := node.CheckBrowseQuery(rootID, relPath, cursor); err != nil {
		var browseErr *node.BrowseError
		if errors.As(err, &browseErr) {
			status, code, message := fileError(browseErr.Code, browseErr.Message)
			s.writeError(w, r, status, code, message)
			return "", "", "", false
		}
		s.writeError(w, r, http.StatusBadRequest, "invalid_path", "路径不正确")
		return "", "", "", false
	}
	return rootID, relPath, cursor, true
}

type fileView struct {
	OperationID string                  `json:"operation_id"`
	NodeID      string                  `json:"node_id"`
	Kind        string                  `json:"kind"`
	RootID      string                  `json:"root_id,omitempty"`
	Path        string                  `json:"path,omitempty"`
	Roots       []protocol.FileRoot     `json:"roots,omitempty"`
	Entries     []protocol.FileEntry    `json:"entries,omitempty"`
	Content     *string                 `json:"content,omitempty"`
	Size        *int64                  `json:"size,omitempty"`
	Truncated   bool                    `json:"truncated"`
	Remainder   *protocol.FileRemainder `json:"remainder,omitempty"`
	NextCursor  string                  `json:"next_cursor,omitempty"`
}

func sanitizeFileResult(result *protocol.FileResult) error {
	if result.Kind != protocol.FileKindFile {
		result.Content = nil
		return nil
	}
	if result.Content == nil {
		empty := ""
		result.Content = &empty
		return nil
	}
	text := *result.Content
	if strings.ContainsRune(text, 0) || !utf8.ValidString(text) {
		result.Content = nil
		return errors.New("not text")
	}
	if len(text) > protocol.FilePreviewBytes {
		text = text[:protocol.FilePreviewBytes]
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		result.Content = &text
		result.Truncated = true
		if result.Remainder == nil {
			result.Remainder = &protocol.FileRemainder{
				RootID: result.RootID,
				Path:   result.Path,
				Kind:   protocol.FileKindFile,
			}
		}
		result.Remainder.Offset = int64(len(text))
	}
	return nil
}

type fileStatus struct {
	status  int
	message string
}

var fileStatuses = map[string]fileStatus{
	protocol.FileCodePathEscaped:   {http.StatusForbidden, "路径超出允许的目录"},
	protocol.FileCodeRootForbidden: {http.StatusForbidden, "不能浏览该目录"},
	protocol.FileCodeInvalidPath:   {http.StatusBadRequest, "路径不正确"},
	protocol.FileCodeNotFound:      {http.StatusNotFound, "找不到该路径"},
	protocol.FileCodeNotText:       {http.StatusUnsupportedMediaType, "只能预览文本，不能通过浏览接口读取该文件"},
	protocol.FileCodeUnavailable:   {http.StatusServiceUnavailable, "暂时无法浏览该路径"},
}

var allowedFileMessages = map[string]struct{}{
	"路径超出允许的目录": {},
	"不能浏览该目录":   {},
	"路径不正确":     {},
	"找不到该路径":    {},
	"只能预览文本，不能通过浏览接口读取该文件": {},
	"暂时无法浏览该路径":            {},
	"没有权限读取该路径":            {},
	"浏览目录无法打开":             {},
	"浏览目录配置无法使用":           {},
	"浏览目录配置正被占用":           {},
	"不能按条目游标读取文件内容":        {},
	"列出授权目录时不能指定路径":        {},
	"目录标识不正确":              {},
	"浏览请求无效":               {},
	"结果超过消息上限":             {},
}

func fileError(code, message string) (int, string, string) {
	status, ok := fileStatuses[code]
	if !ok {
		return http.StatusServiceUnavailable, protocol.FileCodeUnavailable, "暂时无法浏览该路径"
	}
	if _, allowed := allowedFileMessages[message]; !allowed {
		message = status.message
	}
	return status.status, code, message
}
