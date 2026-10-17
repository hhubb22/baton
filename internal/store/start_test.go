package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/startpermit"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStartAuthorizationCommitFailureDoesNotIssue(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	repo.SetStartCommitHook(func(context.Context) error {
		return errors.New("提交失败")
	})
	decision, err := repo.AuthorizeStart(ctx, in)
	if err == nil || decision.Issue {
		t.Fatalf("提交失败仍然要求签发: %v %+v", err, decision)
	}
	var authorized bool
	if err := pool.QueryRow(ctx, `SELECT start_authorized_at IS NOT NULL FROM executions WHERE id = $1::uuid`, in.ExecutionID).Scan(&authorized); err != nil || authorized {
		t.Fatalf("失败的事务留下了授权: %v %v", err, authorized)
	}
}

func TestStartAndCancelRaceKeepsPossibleStart(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	entered := make(chan struct{})
	repo.SetStartCommitHook(func(context.Context) error {
		close(entered)
		time.Sleep(400 * time.Millisecond)
		return nil
	})
	type cancelResult struct {
		decision store.CancelDecision
		err      error
	}
	cancelCh := make(chan cancelResult, 1)
	go func() {
		<-entered
		d, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
		cancelCh <- cancelResult{d, err}
	}()
	decision, err := repo.AuthorizeStart(ctx, in)
	if err != nil || !decision.Issue || decision.Claims.ExecutionID != in.ExecutionID {
		t.Fatalf("授权没有提交: %v %+v", err, decision)
	}
	cancelled := <-cancelCh
	if cancelled.err != nil || cancelled.decision.Status != task.StatusNeedsVerification || !cancelled.decision.PossibleStart {
		t.Fatalf("许可和取消竞态被当成未执行: %v %+v", cancelled.err, cancelled.decision)
	}
	var status string
	var authorized, refused bool
	if err := pool.QueryRow(ctx, `
		SELECT t.status, e.start_authorized_at IS NOT NULL, e.start_refused_at IS NOT NULL
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &authorized, &refused); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusNeedsVerification || !authorized || refused {
		t.Fatalf("竞态后的事实不正确: status %s authorized %v refused %v", status, authorized, refused)
	}
	again, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
	if err != nil || again.Status != task.StatusNeedsVerification || !again.PossibleStart {
		t.Fatalf("重复取消改变了可能已启动的事实: %v %+v", err, again)
	}
}

func TestCancelBeforePermitDoesNotAuthorize(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	entered := make(chan struct{})
	repo.SetCancelCommitHook(func(context.Context) error {
		close(entered)
		time.Sleep(400 * time.Millisecond)
		return nil
	})
	var decision store.StartDecision
	var authErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-entered
		decision, authErr = repo.AuthorizeStart(ctx, in)
	}()
	cancelled, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
	if err != nil || cancelled.Status != task.StatusCancelled || cancelled.PossibleStart {
		t.Fatalf("授权前的取消不正确: %v %+v", err, cancelled)
	}
	wg.Wait()
	if authErr != nil || decision.Issue || decision.PossibleStart {
		t.Fatalf("取消之后仍然签发: %v %+v", authErr, decision)
	}
	var status string
	var authorized bool
	if err := pool.QueryRow(ctx, `
		SELECT t.status, e.start_authorized_at IS NOT NULL
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &authorized); err != nil || status != task.StatusCancelled || authorized {
		t.Fatalf("取消后的任务不正确: %v %s %v", err, status, authorized)
	}
}

func TestRevokeBeforeAndAfterAuthorization(t *testing.T) {
	ctx, repo, pool, in, ident := preparedStart(t)
	bad := in
	bad.StorageGeneration = mustUUID(t)
	decision, err := repo.AuthorizeStart(ctx, bad)
	if err != nil || decision.Issue || decision.Code != task.CodeInvalidTarget {
		t.Fatalf("错误存储代次被授权: %v %+v", err, decision)
	}
	if _, err := repo.RevokeNode(ctx, in.EmployeeID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	decision, err = repo.AuthorizeStart(ctx, in)
	if err != nil || decision.Issue || decision.PossibleStart || decision.Code != task.CodeRevoked {
		t.Fatalf("吊销前的许可被签发: %v %+v", err, decision)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `SELECT status, COALESCE(error_code, '') FROM tasks WHERE id = $1::uuid`, in.TaskID).Scan(&status, &code); err != nil || status != task.StatusFailed || code != task.CodeRevoked {
		t.Fatalf("未启动的吊销结果不正确: %v %s %s", err, status, code)
	}

	ctx, repo, pool, in, ident = preparedStart(t)
	decision, err = repo.AuthorizeStart(ctx, in)
	if err != nil || !decision.Issue {
		t.Fatalf("正常授权失败: %v %+v", err, decision)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.SignStartPermit(decision.Claims)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := signer.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	got, err := startpermit.Verify(pub, token)
	if err != nil || got.ExecutionID != in.ExecutionID || got.StorageGeneration != in.StorageGeneration {
		t.Fatalf("签发的许可不能按执行身份验签: %+v %v", got, err)
	}
	if _, err := repo.RevokeNode(ctx, in.EmployeeID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	again, err := repo.AuthorizeStart(ctx, in)
	if err != nil || again.Issue || !again.PossibleStart {
		t.Fatalf("吊销之后把已授权任务当成未执行: %v %+v", err, again)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id = $1::uuid`, in.TaskID).Scan(&after); err != nil || after != task.StatusNeedsVerification {
		t.Fatalf("吊销后的状态是 %s %v", after, err)
	}
}

func TestQueueExpiryConfirmsOnlyWhenNotAuthorized(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := pool.Exec(ctx, `UPDATE tasks SET queue_expires_at = now() + interval '200 milliseconds' WHERE id = $1::uuid`, in.TaskID); err != nil {
		t.Fatal(err)
	}
	decision, err := repo.AuthorizeStart(ctx, in)
	if err != nil || decision.Issue || decision.PossibleStart || decision.Code != task.CodeQueueTimeout {
		t.Fatalf("不足的排队时间被授权: %v %+v", err, decision)
	}

	ctx, repo, pool, in, _ = preparedStart(t)
	decision, err = repo.AuthorizeStart(ctx, in)
	if err != nil || !decision.Issue {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE tasks
		SET created_at = now() - interval '1 hour', queue_expires_at = now() - interval '1 second'
		WHERE id = $1::uuid`, in.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := repo.ExpireQueuedTasks(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	var authorized bool
	if err := pool.QueryRow(ctx, `
		SELECT t.status, e.start_authorized_at IS NOT NULL
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &authorized); err != nil || status != task.StatusNeedsVerification || !authorized {
		t.Fatalf("到期后的已授权任务被当成未执行: %v %s %v", err, status, authorized)
	}
	if err := repo.RecordStartRefusal(ctx, in.EmployeeID, in.NodeID, in.TaskID, in.ExecutionID); err != nil {
		t.Fatal(err)
	}
	var mid string
	if err := pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id = $1::uuid`, in.TaskID).Scan(&mid); err != nil || mid != task.StatusNeedsVerification {
		t.Fatalf("只有未启动回执时被提前标成已取消: %v %s", err, mid)
	}
	final, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
	if err != nil || final.Status != task.StatusCancelled || final.PossibleStart {
		t.Fatalf("未启动回执之后的取消不正确: %v %+v", err, final)
	}
}

func preparedStart(t *testing.T) (context.Context, *store.Store, *pgxpool.Pool, store.StartRequest, node.Identity) {
	t.Helper()
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	desk := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, desk.NodeID, "pi")
	accepted, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "start-" + mustUUID(t), Description: "核对启动许可"})
	if err != nil {
		t.Fatal(err)
	}
	connID := markOnline(t, ctx, repo, alice.ID, desk)
	if err := repo.SyncNode(ctx, alice.ID, desk.NodeID, connID, desk.DisplayName, desk.System, desk.Role, desk.Capabilities); err != nil {
		t.Fatal(err)
	}
	intent, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok {
		t.Fatalf("没有领到准备投递: %v %v", err, ok)
	}
	sessionID := mustUUID(t)
	generation := mustUUID(t)
	if err := repo.SavePrepared(ctx, store.PreparedFact{
		MessageID: intent.MessageID, EmployeeID: alice.ID, NodeID: desk.NodeID,
		TaskID: accepted.TaskID, ExecutionID: intent.ExecutionID,
		SessionID: sessionID, StorageGeneration: generation,
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, repo, pool, store.StartRequest{
		EmployeeID: alice.ID, NodeID: desk.NodeID, CredentialID: desk.Credential.ID,
		TaskID: accepted.TaskID, ExecutionID: intent.ExecutionID, SessionID: sessionID,
		StorageGeneration: generation, Nonce: mustUUID(t),
	}, desk
}
