package agentcli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/task"
)

const usage = "baton delegate --request-file FILE --json | baton task get|wait|result|relations|cancel TASK_ID [--timeout 30s] --json | baton result submit --file FILE --json"

func Run(ctx context.Context, args []string, out io.Writer, getenv func(string) string) error {
	req, timeout, err := parse(args)
	if err != nil {
		return err
	}
	path := getenv(ContextEnv)
	if timeout == 0 {
		result, err := Call(ctx, path, req)
		if err != nil {
			return err
		}
		return writeResult(out, result)
	}
	return wait(ctx, path, req, timeout, out)
}

func parse(args []string) (Request, time.Duration, error) {
	var req Request
	var rest []string
	if len(args) > 0 && args[0] == "delegate" {
		req.Operation, rest = "delegate", args[1:]
	} else if len(args) >= 2 && args[0] == "result" && args[1] == "submit" {
		req.Operation, rest = "submit_result", args[2:]
	} else if len(args) >= 3 && args[0] == "task" {
		req.Operation, req.TaskID, rest = args[1], args[2], args[3:]
		id, err := identity.ParseUUID(req.TaskID)
		if err != nil {
			return req, 0, errors.New("任务标识不正确")
		}
		req.TaskID = id
		switch req.Operation {
		case "get", "wait", "result", "relations", "cancel":
		default:
			return req, 0, errors.New(usage)
		}
	} else {
		return req, 0, errors.New(usage)
	}
	fs := flag.NewFlagSet("baton", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	jsonOutput := fs.Bool("json", false, "")
	var file string
	var timeout time.Duration
	if req.Operation == "delegate" {
		fs.StringVar(&file, "request-file", "", "")
	}
	if req.Operation == "submit_result" {
		fs.StringVar(&file, "file", "", "")
	}
	if req.Operation == "wait" {
		fs.DurationVar(&timeout, "timeout", 30*time.Second, "")
	}
	if fs.Parse(rest) != nil || fs.NArg() != 0 || !*jsonOutput {
		return req, 0, errors.New(usage)
	}
	if req.Operation == "delegate" {
		var in task.Input
		if file == "" || ReadFile(file, &in) != nil {
			return req, 0, errors.New("委托请求文件无效")
		}
		if err := task.ValidateRequestID(in.RequestID); err != nil {
			return req, 0, err
		}
		req.Input = &in
	}
	if req.Operation == "wait" && (timeout <= 0 || timeout > 5*time.Minute) {
		return req, 0, errors.New("等待期限必须大于 0 且不超过 5m")
	}
	if req.Operation == "submit_result" {
		f, err := os.Open(file)
		if err != nil {
			return req, 0, errors.New("候选结果文件无效")
		}
		defer f.Close()
		raw, err := io.ReadAll(io.LimitReader(f, protocol.MaxMessageBytes+1))
		if err != nil || len(raw) > protocol.MaxMessageBytes {
			return req, 0, errors.New("候选结果文件超过上限")
		}
		if _, err := task.ParseCandidate(string(raw)); err != nil {
			return req, 0, err
		}
		req.Candidate = string(raw)
	}
	return req, timeout, nil
}

func writeResult(out io.Writer, result protocol.AgentResult) error {
	if !result.OK {
		if err := json.NewEncoder(out).Encode(result); err != nil {
			return err
		}
		return errors.New("操作被拒绝: " + result.Code)
	}
	if len(result.Data) == 0 {
		return errors.New("响应缺少数据")
	}
	_, err := out.Write(append(result.Data, '\n'))
	return err
}

func wait(ctx context.Context, path string, req Request, timeout time.Duration, out io.Writer) error {
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req.Operation = "get"
	var last json.RawMessage
	var version int
	finish := func(waiting, timedOut bool) error {
		return json.NewEncoder(out).Encode(struct {
			TaskID   string          `json:"task_id"`
			Waiting  bool            `json:"waiting"`
			TimedOut bool            `json:"timed_out"`
			Task     json.RawMessage `json:"task"`
		}{req.TaskID, waiting, timedOut, last})
	}
	for {
		result, err := Call(waitCtx, path, req)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if waitCtx.Err() != nil {
				return finish(true, true)
			}
			return err
		}
		if !result.OK {
			return writeResult(out, result)
		}
		var current task.Record
		if json.Unmarshal(result.Data, &current) != nil || current.TaskID != req.TaskID {
			return errors.New("任务响应无效")
		}
		last = result.Data
		terminal := current.Status == task.StatusCompleted || current.Status == task.StatusFailed || current.Status == task.StatusCancelled
		if terminal || current.Status == task.StatusNeedsVerification || (version != 0 && version != current.Version) {
			return finish(!terminal, false)
		}
		version = current.Version
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-waitCtx.Done():
			timer.Stop()
			return finish(true, true)
		case <-timer.C:
		}
	}
}
