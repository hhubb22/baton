package node

import (
	"context"
	"encoding/json"
	"errors"
	"os/user"

	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/projectexec"
	"baton/internal/projectruntime"
	"baton/internal/protocol"
)

type subscriptionLoginStarter = func(context.Context, string, func()) (protocol.SubscriptionLoginResult, error)

func triggerRefresh(reports *runtimeReports) {
	if reports != nil {
		select {
		case reports.refresh <- struct{}{}:
		default:
		}
	}
}

func handleNodeSettings(ctx context.Context, raw []byte, w *wsWriter, dir string, reports *runtimeReports, startLogin subscriptionLoginStarter) bool {
	var wrap struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	if json.Unmarshal(raw, &wrap) != nil {
		return false
	}
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(wrap.Envelope.Body, &head) != nil {
		return false
	}
	switch head.Type {
	case protocol.BodyProjectExecSet, protocol.BodyBrowseRootsSet, protocol.BodySubscriptionLogin:
	default:
		return false
	}
	env := wrap.Envelope
	if env.Source == nil || env.Source.Kind != protocol.SourceControl {
		return true
	}
	// 目录扫描和登录启动不阻塞连接上的心跳与其他响应。
	respond := func() {
		var result any
		switch head.Type {
		case protocol.BodyProjectExecSet:
			result = setProjectExec(env.Body, dir, reports)
		case protocol.BodyBrowseRootsSet:
			result = setBrowseRoots(ctx, env.Body, dir, reports)
		case protocol.BodySubscriptionLogin:
			result = startSubscriptionLogin(ctx, env.Body, reports, startLogin)
		}
		messageID, err := identity.NewUUID()
		if err != nil {
			return
		}
		body, _ := json.Marshal(result)
		rawEnv, _ := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: messageID, Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, CorrelationID: env.MessageID, Body: body})
		frame, _ := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: rawEnv})
		_ = w.write(ctx, frame)
	}
	if head.Type == protocol.BodyProjectExecSet {
		respond()
	} else {
		go respond()
	}
	return true
}

func setProjectExec(raw []byte, dir string, reports *runtimeReports) protocol.ProjectExecResult {
	var req protocol.ProjectExecRequest
	result := protocol.ProjectExecResult{Type: protocol.BodyProjectExecResult, Code: "invalid_request"}
	if protocol.DecodeRuntimeMessage(raw, &req) != nil {
		return result
	}
	result.OperationID = req.OperationID
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		return result
	}
	cfg, err := projectexec.SetEnabled(dir, req.Enabled)
	if err != nil {
		result.Code = "config_unavailable"
		return result
	}
	result.OK, result.Code = true, ""
	cfg.User = ""
	if current, err := user.Current(); err == nil {
		cfg.User = current.Username
	}
	result.Exec = &cfg
	triggerRefresh(reports)
	return result
}

func setBrowseRoots(ctx context.Context, raw []byte, dir string, reports *runtimeReports) protocol.BrowseRootsResult {
	var req protocol.BrowseRootsRequest
	result := protocol.BrowseRootsResult{Type: protocol.BodyBrowseRootsResult, Code: "invalid_request", Message: "目录设置请求无效"}
	if protocol.DecodeRuntimeMessage(raw, &req) != nil {
		return result
	}
	result.OperationID = req.OperationID
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		return result
	}
	var err error
	switch req.Action {
	case "add":
		_, err = AddBrowseRootPath(dir, req.Path)
	case "remove":
		err = RemoveBrowseRootPath(dir, req.Path)
	default:
		return result
	}
	if err != nil {
		result.Code, result.Message = "config_unavailable", "无法保存目录设置"
		var browseErr *BrowseError
		if errors.As(err, &browseErr) {
			result.Code, result.Message = browseErr.Code, browseErr.Message
		}
		return result
	}
	scanCtx, cancel := context.WithTimeout(ctx, runtimeCollectTimeout)
	defer cancel()
	result.Roots, result.Repos, _ = fileaccess.ScanRuntimeRoots(scanCtx, dir)
	result.OK, result.Code, result.Message = true, "", ""
	triggerRefresh(reports)
	return result
}

func startSubscriptionLogin(ctx context.Context, raw []byte, reports *runtimeReports, startLogin subscriptionLoginStarter) protocol.SubscriptionLoginResult {
	var req protocol.SubscriptionLoginRequest
	result := protocol.SubscriptionLoginResult{Type: protocol.BodySubscriptionLoginResult, Code: "invalid_request", Message: "订阅登录请求无效"}
	if protocol.DecodeRuntimeMessage(raw, &req) != nil {
		return result
	}
	result.OperationID = req.OperationID
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		return result
	}
	if startLogin == nil {
		startLogin = projectruntime.StartDeviceLogin
	}
	login, err := startLogin(ctx, req.Provider, func() { triggerRefresh(reports) })
	if err != nil {
		result.Code, result.Message = "login_unavailable", "无法发起订阅登录，请检查 Runtime 安装和订阅服务"
		return result
	}
	login.Type, login.OperationID = result.Type, req.OperationID
	return login
}
