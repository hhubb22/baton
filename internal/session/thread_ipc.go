package session

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/identity"
	"baton/internal/protocol"
)

func nativeThreadAdapter(kind string, config agent.Config) (agent.ThreadAdapter, error) {
	registration, ok := registeredAdapters[kind]
	if !ok {
		return nil, errors.New("尚未实现的 Thread 适配器")
	}
	adapter := registration.new(config)
	thread, ok := adapter.(agent.ThreadAdapter)
	if !ok {
		_ = adapter.Close()
		return nil, agent.ErrUnsupported
	}
	return thread, nil
}

// OpenThread 创建持久配置并连接或启动对应 Worker。重复调用核对原配置。
func (h *Host) OpenThread(ctx context.Context, options ThreadOptions) error {
	if options.StorageGeneration == "" || options.AgentType == "" || options.WorkingDirectory == "" {
		return errors.New("Thread 配置无效")
	}
	dir, err := SessionDir(h.DataDir, options.ThreadID)
	if err != nil {
		return err
	}
	// 本地配置中的执行身份始终由 Host 填写。
	config := options.AdapterConfig
	config.DataDir, config.Directory, config.SessionID, config.ExecutionID = h.DataDir, options.WorkingDirectory, options.ThreadID, options.ThreadID
	config.SessionDir = filepath.Join(dir, "native")
	config.StatePath = filepath.Join(config.SessionDir, "state.json")
	if registration, ok := registeredAdapters[options.AgentType]; ok {
		if config.Model == "" {
			config.Model = os.Getenv(registration.modelEnv)
		}
		if config.Binary == "" {
			config.Binary = os.Getenv(registration.binaryEnv)
		}
		if config.Home == "" {
			config.Home = os.Getenv(registration.homeEnv)
		}
	}
	options.AdapterConfig = config
	// 同一 Session 目录不能同时交给旧任务 Worker 和 Thread Worker。
	legacy, _ := LedgerPath(h.DataDir, options.ThreadID)
	if _, err := os.Stat(legacy); err == nil {
		return ErrSessionBusy
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	db, _, err := openThreadDB(h.DataDir, options, true)
	if err != nil {
		return err
	}
	db.Close()
	_, err = h.threadCall(ctx, options.ThreadID, ipcMessage{Type: "thread_open"})
	return err
}

func (h *Host) threadCall(ctx context.Context, threadID string, msg ipcMessage) (Status, error) {
	call := func(c *Client) (Status, error) { return c.roundTrip(msg) }
	st, err := h.call(ctx, threadID, call)
	var rejected *ThreadCommandError
	if err == nil || errors.As(err, &rejected) {
		return st, err
	}
	path, pathErr := ThreadLedgerPath(h.DataDir, threadID)
	if pathErr != nil {
		return Status{}, pathErr
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return Status{}, statErr
	}
	if err := h.spawn(ctx, threadID); err != nil {
		return Status{}, err
	}
	return h.call(ctx, threadID, call)
}

func (h *Host) ThreadMessage(ctx context.Context, threadID, clientMessageID, content, mode string) error {
	_, err := h.threadCall(ctx, threadID, ipcMessage{Type: "thread_message", ClientMessageID: clientMessageID, Payload: content, Mode: mode})
	return err
}
func (h *Host) ThreadWithdraw(ctx context.Context, threadID, clientMessageID string) error {
	_, err := h.threadCall(ctx, threadID, ipcMessage{Type: "thread_withdraw", ClientMessageID: clientMessageID})
	return err
}
func (h *Host) ThreadStop(ctx context.Context, threadID, reason string) error {
	_, err := h.threadCall(ctx, threadID, ipcMessage{Type: "thread_stop", StopReason: reason})
	return err
}
func (h *Host) ThreadPending(ctx context.Context, threadID string, afterWorkerSeq int64) ([]protocol.ThreadReport, error) {
	st, err := h.threadCall(ctx, threadID, ipcMessage{Type: "thread_pending", AfterWorkerSeq: afterWorkerSeq})
	return st.ThreadReports, err
}
func (h *Host) ThreadAck(ctx context.Context, threadID, eventID string, workerSeq int64) error {
	_, err := h.threadCall(ctx, threadID, ipcMessage{Type: "thread_ack", EventID: eventID, WorkerSeq: workerSeq})
	return err
}

func (c *Client) OpenThread() error {
	_, err := c.roundTrip(ipcMessage{Type: "thread_open"})
	return err
}

func (c *Client) ThreadMessage(id, content, mode string) error {
	_, err := c.roundTrip(ipcMessage{Type: "thread_message", ClientMessageID: id, Payload: content, Mode: mode})
	return err
}
func (c *Client) ThreadWithdraw(id string) error {
	_, err := c.roundTrip(ipcMessage{Type: "thread_withdraw", ClientMessageID: id})
	return err
}
func (c *Client) ThreadStop(reason string) error {
	_, err := c.roundTrip(ipcMessage{Type: "thread_stop", StopReason: reason})
	return err
}
func (c *Client) ThreadPending(after int64) ([]protocol.ThreadReport, error) {
	st, err := c.roundTrip(ipcMessage{Type: "thread_pending", AfterWorkerSeq: after})
	return st.ThreadReports, err
}
func (c *Client) ThreadAck(id string, seq int64) error {
	_, err := c.roundTrip(ipcMessage{Type: "thread_ack", EventID: id, WorkerSeq: seq})
	return err
}

// runThreadWorker 由 RunWorker 在取得 Session 文件锁后调用。
func runThreadWorker(ctx context.Context, dataDir, threadID, token string, logger *slog.Logger) error {
	db, options, err := openThreadDB(dataDir, ThreadOptions{ThreadID: threadID}, false)
	if err != nil {
		return err
	}
	db.Close()
	worker, err := OpenThreadWorker(ctx, dataDir, options, nativeThreadAdapter)
	if err != nil {
		return err
	}
	defer worker.Close()
	worker.forceKill = killThreadChildren
	endpoint, err := Endpoint(dataDir, threadID)
	if err != nil {
		return err
	}
	ln, err := listenEndpoint(endpoint)
	if err != nil {
		return err
	}
	defer ln.Close()
	defer os.Remove(endpoint)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				ln.Close()
				return
			case <-ticker.C:
				if err := worker.Poll(runCtx); err != nil {
					logger.Error("event=thread_poll_failed", "thread_id", threadID)
				}
			}
		}
	}()
	defer func() { cancel(); <-done }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go serveThreadConn(runCtx, conn, strings.TrimSpace(token), worker)
	}
}

func serveThreadConn(ctx context.Context, conn net.Conn, token string, w *ThreadWorker) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), (256<<10)+1)
	decode := func(message *ipcMessage) error {
		if !scanner.Scan() {
			return errors.New("Worker IPC 已结束或帧超过上限")
		}
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(message); err != nil {
			return err
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return errors.New("Worker IPC 帧含尾随数据")
		}
		return nil
	}
	enc := json.NewEncoder(conn)
	var auth ipcMessage
	if err := decode(&auth); err != nil || auth.Type != "auth" || subtle.ConstantTimeCompare([]byte(auth.Token), []byte(token)) != 1 {
		_ = enc.Encode(ipcMessage{Type: "result", Code: "unauthorized"})
		return
	}
	if err := enc.Encode(ipcMessage{Type: "result", OK: true}); err != nil {
		return
	}
	for {
		_ = conn.SetDeadline(time.Now().Add(35 * time.Second))
		var msg ipcMessage
		if err := decode(&msg); err != nil {
			return
		}
		reply := handleThreadWorker(ctx, w, msg)
		if err := enc.Encode(reply); err != nil {
			return
		}
	}
}

func handleThreadWorker(ctx context.Context, w *ThreadWorker, msg ipcMessage) ipcMessage {
	reply := ipcMessage{Type: "result", OK: true, PID: os.Getpid(), SessionID: w.options.ThreadID}
	var err error
	switch msg.Type {
	case "status", "thread_open":
	case "thread_message":
		err = w.EnqueueThreadMessage(ctx, msg.ClientMessageID, msg.Payload, msg.Mode)
	case "thread_withdraw":
		err = w.WithdrawThreadMessage(msg.ClientMessageID)
	case "thread_stop":
		err = w.StopThread(msg.StopReason)
	case "thread_pending":
		reply.ThreadReports, err = w.ThreadPending(msg.AfterWorkerSeq)
	case "thread_ack":
		err = w.ThreadAck(msg.EventID, msg.WorkerSeq)
	case "session_request":
		if msg.SessionRequest == nil {
			err = errors.New("缺少 session.request")
		} else {
			result := w.SessionRequest(ctx, *msg.SessionRequest)
			reply.SessionResult = &result
		}
	case "native_history":
		w.mu.Lock()
		if w.adapter == nil {
			err = agent.ErrHistoryMissing
		} else {
			var page agent.HistoryPage
			page, err = w.adapter.ReadHistory(ctx, msg.Payload)
			reply.History, reply.HistoryCursor = page.Data, page.NextCursor
		}
		w.mu.Unlock()
	default:
		err = errors.New("未知的 Thread Worker 请求")
	}
	if err != nil {
		reply.OK = false
		reply.Code = "thread_rejected"
		reply.Message = err.Error()
	}
	return reply
}

// SessionRequest 通过 Thread ID 读取原生历史或内存中的实时输出。
func (w *ThreadWorker) SessionRequest(ctx context.Context, req protocol.SessionRequest) protocol.SessionResult {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: w.options.ThreadID}
	if req.SessionID != w.options.ThreadID {
		result.Code = "invalid_request"
		return result
	}
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		result.Code = "invalid_request"
		return result
	}
	if req.Action == "history" {
		if a, ok := w.adapter.(agent.BrowserHistoryAdapter); ok {
			page, err := a.ReadBrowserHistory(ctx, req.Cursor, req.Limit)
			return historyResult(req, page, err)
		}
		return historyResult(req, protocol.SessionHistoryPage{}, agent.ErrHistoryMissing)
	}
	if err := w.drainLocked(); err != nil {
		result.Code = "unavailable"
		return result
	}
	result.State, _ = w.status()
	if req.Action == "validate_directory" {
		result.OK = filepath.Clean(req.Text) == filepath.Clean(w.options.WorkingDirectory)
		if !result.OK {
			result.Code = "invalid_directory"
		}
		return result
	}
	if req.Action == "resume" {
		result.OK = true
		return result
	}
	if req.Action != "output" {
		result.Code = "unsupported"
		return result
	}
	live := &w.live
	if live.liveEpoch == "" {
		live.liveEpoch, _ = identity.NewUUID()
	}
	offset := live.liveBase
	if req.Cursor != "" {
		epoch, raw, ok := strings.Cut(req.Cursor, ":")
		n, err := strconv.ParseInt(raw, 10, 64)
		if !ok || err != nil || n < 0 {
			result.Code = "invalid_cursor"
			return result
		}
		if epoch == live.liveEpoch && n >= live.liveBase && n <= live.liveEnd {
			offset = n
		} else {
			result.Gap = true
		}
	} else {
		result.Gap = live.liveBase > 0
	}
	end := min(offset+protocol.SessionOutputBytes, live.liveEnd)
	// 游标只能落在 UTF-8 字符边界。
	if offset < live.liveEnd && !utf8.RuneStart(live.liveText[offset-live.liveBase]) {
		result.Code = "invalid_cursor"
		return result
	}
	for end > offset && end < live.liveEnd && !utf8.RuneStart(live.liveText[end-live.liveBase]) {
		end--
	}
	result.Text = live.liveText[offset-live.liveBase : end-live.liveBase]
	result.Cursor = live.liveEpoch + ":" + strconv.FormatInt(end, 10)
	result.Gap = result.Gap || live.liveGap
	result.OK = true
	return result
}
