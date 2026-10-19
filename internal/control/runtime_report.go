package control

import (
	"context"
	"errors"

	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) onRuntimeReport(ctx context.Context, connID string, env protocol.Envelope) {
	result := protocol.RuntimeReportResult{Type: protocol.BodyRuntimeReportResult}
	var req protocol.RuntimeReportRequest
	if protocol.DecodeRuntimeJSON(env.Body, &req) != nil || req.Type != protocol.BodyRuntimeReport {
		result.Code = protocol.CodeInvalidMessage
	} else {
		version, err := s.store.SaveRuntimeReport(ctx, *env.Source, req.Report)
		switch {
		case err == nil:
			result.OK, result.ReportVersion = true, version
		case errors.Is(err, protocol.ErrRuntimeReport):
			result.Code = protocol.CodeInvalidMessage
		case errors.Is(err, store.ErrSyncRejected):
			result.Code = protocol.CodeSyncRejected
		default:
			result.Code = protocol.CodeControlUnavailable
		}
	}
	// 日志只记录节点和结果，不写路径、origin 或 probe 输出。
	s.log.Info("event=runtime_report", "node_id", env.Source.NodeID, "ok", result.OK, "code", result.Code, "report_version", result.ReportVersion)
	s.replyExecution(ctx, connID, env, result)
}
