package node

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/protocol"
)

func handleFileEnvelope(ctx context.Context, raw []byte, w *wsWriter, dataDir string, log *slog.Logger) bool {
	var wrap struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return false
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(wrap.Envelope.Body, &kind); err != nil || kind.Type != protocol.BodyFileBrowse {
		return false
	}
	if wrap.Envelope.Source == nil || wrap.Envelope.Source.Kind != protocol.SourceControl {
		log.Info("event=file_browse_ignored")
		return true
	}
	dec := json.NewDecoder(bytes.NewReader(wrap.Envelope.Body))
	dec.DisallowUnknownFields()
	var req protocol.FileRequest
	if err := dec.Decode(&req); err != nil || req.Type != protocol.BodyFileBrowse {
		writeFileResult(ctx, w, wrap.Envelope.MessageID, protocol.FileResult{
			Type:        protocol.BodyFileResult,
			OperationID: req.OperationID,
			Code:        protocol.FileCodeInvalidPath,
			Message:     "浏览请求无效",
		})
		return true
	}
	result := Browse(dataDir, req)
	if result.OK {
		log.Info("event=file_browse", "root_id", req.RootID, "kind", result.Kind, "truncated", result.Truncated)
	} else {
		log.Info("event=file_browse_rejected", "root_id", req.RootID, "code", result.Code)
	}
	writeFileResult(ctx, w, wrap.Envelope.MessageID, result)
	return true
}

func writeFileResult(ctx context.Context, w *wsWriter, correlation string, result protocol.FileResult) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return
	}
	result = fitFileResult(result)
	frame, err := encodeFileFrame(messageID, correlation, result)
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return
	}
	_ = w.write(ctx, frame)
}

func fitFileResult(result protocol.FileResult) protocol.FileResult {
	messageID := "00000000-0000-4000-8000-000000000001"
	correlation := "00000000-0000-4000-8000-000000000002"
	for {
		frame, err := encodeFileFrame(messageID, correlation, result)
		if err != nil {
			return browseFail(result, protocol.FileCodeUnavailable, "结果超过消息上限")
		}
		if len(frame) <= protocol.MaxMessageBytes {
			return result
		}
		if result.Content == nil || *result.Content == "" {
			failed := browseFail(result, protocol.FileCodeUnavailable, "结果超过消息上限")
			failed.OperationID = result.OperationID
			return failed
		}
		text := *result.Content
		next := len(text) / 2
		if next >= len(text) {
			next = len(text) - 1
		}
		text = text[:next]
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		result.Content = &text
		result.Truncated = true
		if result.Remainder == nil {
			result.Remainder = &protocol.FileRemainder{Kind: protocol.FileKindFile}
		}
		result.Remainder.Offset = int64(len(text))
	}
}

func encodeFileFrame(messageID, correlation string, result protocol.FileResult) ([]byte, error) {
	if result.Type == "" {
		result.Type = protocol.BodyFileResult
	}
	body, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:       protocol.Version,
		MessageID:     messageID,
		Route:         protocol.Route{To: protocol.ToControl},
		Priority:      protocol.PriorityControl,
		CorrelationID: correlation,
		Body:          body,
	})
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
}
