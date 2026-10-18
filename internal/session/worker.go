package session

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

// RunWorker 是 batond 的内部子命令。它只绑定 Session 账本，不启动 Agent，也不运行启动钩子。
func RunWorker(ctx context.Context, dataDir, sessionID string) error {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return errors.New("Session 标识不正确")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("无法创建 Session 目录")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return errors.New("无法限制 Session 目录的权限")
	}
	lockPath, err := LockPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	lock := flock.New(lockPath)
	ok, err := lock.TryLock()
	if err != nil {
		return errors.New("无法锁定 Session")
	}
	if !ok {
		return ErrSessionOwned
	}
	defer lock.Unlock()
	release, err := holdAgentJob()
	if err != nil {
		return errors.New("无法创建 Agent Job")
	}
	defer release()
	tokenPath, err := TokenPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return errors.New("无法读取 Worker 认证令牌")
	}
	tokenText := strings.TrimSpace(string(token))
	if len(tokenText) != 64 {
		return errors.New("Worker 认证令牌无效")
	}
	logPath, err := LogPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("无法写入 Worker 日志")
	}
	defer logFile.Close()
	logger := slog.New(slog.NewTextHandler(logFile, nil))
	ledgerPath, err := LedgerPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	db, err := openWorkerDB(ledgerPath, NewObserver(os.Getenv("BATON_TEST_EXECUTOR_LOG")))
	if err != nil {
		if errors.Is(err, ErrHistoryMissing) || errors.Is(err, ErrHistoryIncompatible) {
			return err
		}
		return errors.New("无法打开 Session 账本")
	}
	if err := db.recover(sessionID); err != nil {
		return errors.New("无法恢复 Session 历史")
	}
	defer db.Close()
	monitorCtx, stopMonitor := context.WithCancel(ctx)
	monitorDone := make(chan struct{})
	defer func() { stopMonitor(); <-monitorDone }()
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-monitorCtx.Done():
				return
			case <-ticker.C:
				if err := db.checkDeadline(sessionID); err != nil {
					logger.Error("event=execution_deadline_failed", "session_id", sessionID)
				}
			}
		}
	}()
	endpoint, err := Endpoint(dataDir, sessionID)
	if err != nil {
		return err
	}
	ln, err := listenEndpoint(endpoint)
	if err != nil {
		return errors.New("无法监听 Worker")
	}
	defer os.Remove(endpoint)
	defer ln.Close()
	logger.Info("event=worker_listening", "session_id", sessionID, "pid", os.Getpid())
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("Worker 监听已结束")
		}
		go serveConn(conn, tokenText, sessionID, db, logger)
	}
}

func serveConn(conn net.Conn, token, sessionID string, db *workerDB, logger *slog.Logger) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	dec := json.NewDecoder(conn)
	enc := json.NewEncoder(conn)
	var auth ipcMessage
	if err := dec.Decode(&auth); err != nil || auth.Type != "auth" || !tokenEqual(auth.Token, token) {
		_ = enc.Encode(ipcMessage{Type: "result", Code: "unauthorized", Message: "认证失败"})
		return
	}
	attaches := db.Attach()
	if err := enc.Encode(ipcMessage{Type: "result", OK: true}); err != nil {
		return
	}
	logger.Info("event=worker_attached", "session_id", sessionID, "attaches", attaches, "pid", os.Getpid())
	for {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		var msg ipcMessage
		if err := dec.Decode(&msg); err != nil {
			return
		}
		reply := handleWorker(db, sessionID, msg)
		if err := enc.Encode(reply); err != nil {
			return
		}
	}
}

func handleWorker(db *workerDB, sessionID string, msg ipcMessage) ipcMessage {
	switch msg.Type {
	case "stop":
		reports, err := db.Stop(sessionID, msg.StopReason)
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法保存中止事实"}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Reports = reports
		return reply
	case "bind":
		// 绑定只写本地账本。这里不能调用执行器，也不能运行启动钩子。
		if err := db.Bind(msg.TaskID, msg.ExecutionID, msg.AgentType); err != nil {
			code := "unavailable"
			if errors.Is(err, ErrSessionBusy) {
				code = "session_busy"
			}
			return ipcMessage{Type: "result", Code: code, Message: err.Error()}
		}
		return statusMessage(db, sessionID, 0)
	case "arm":
		nonce, err := db.Arm(msg.TaskID, msg.ExecutionID)
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: err.Error()}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Nonce = nonce
		return reply
	case "authorize":
		expires, err := time.Parse(time.RFC3339Nano, msg.QueueExpiresAt)
		if err != nil {
			return ipcMessage{Type: "result", Refused: true, Code: "invalid_target", Message: "排队期限无效"}
		}
		started, refused, code, err := db.Authorize(msg.TaskID, msg.ExecutionID, msg.Permit, msg.PublicKey, msg.StorageGeneration, expires)
		if refused {
			message := "启动许可被拒绝"
			if err != nil {
				message = "启动许可被拒绝，拒绝记录写入失败"
			}
			return ipcMessage{Type: "result", Refused: true, Code: code, Message: message}
		}
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法记录启动意图"}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Started = started
		reply.StartIntent = started
		return reply
	case "reject_start":
		if err := db.RejectStart(msg.TaskID, msg.ExecutionID, msg.Code); err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法记录中心拒绝"}
		}
		return statusMessage(db, sessionID, 0)
	case "cancel_local":
		started, err := db.CancelLocal()
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法记录取消"}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Started = started
		reply.StartIntent = started
		return reply
	case "submit_input":
		reports, err := db.SubmitInput(sessionID, msg.Payload)
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法提交任务输入"}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Reports = reports
		return reply
	case "pending":
		reports, err := db.Pending()
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法读取待确认记录"}
		}
		reply := statusMessage(db, sessionID, 0)
		reply.Reports = reports
		return reply
	case "ack":
		if err := db.Ack(msg.EventID); err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "无法确认交付"}
		}
		return statusMessage(db, sessionID, 0)
	case "status":
		return statusMessage(db, sessionID, 0)
	case "append":
		seq, err := db.Append(msg.Note)
		if err != nil {
			return ipcMessage{Type: "result", Code: "unavailable", Message: "写入失败"}
		}
		reply := statusMessage(db, sessionID, seq)
		return reply
	default:
		return ipcMessage{Type: "result", Code: "invalid_message", Message: "无法识别的 Worker 命令"}
	}
}

func statusMessage(db *workerDB, sessionID string, seq int64) ipcMessage {
	snap := db.snapshot()
	return ipcMessage{
		Type:            "result",
		OK:              true,
		PID:             os.Getpid(),
		SessionID:       sessionID,
		TaskID:          snap.taskID,
		ExecutionID:     snap.executionID,
		ExecutorStarts:  db.observer.Starts(),
		ExecutorInputs:  snap.inputs,
		HookRuns:        db.observer.Hooks(),
		InputSubmitted:  snap.inputSubmitted,
		ResultDelivered: snap.resultDelivered,
		Uncertain:       snap.uncertain,
		Attaches:        snap.attaches,
		Seq:             seq,
		StartIntent:     snap.intent,
		Cancelled:       snap.cancelled,
		InputDueAt:      snap.inputDueAt,
	}
}

func tokenEqual(got, want string) bool {
	if len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}
