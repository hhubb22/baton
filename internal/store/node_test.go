package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEarliestPCStaysDefault(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	emp := mustEmployee(t, ctx, pool, "alice", "Alice")

	ubuntu := mustRegister(t, ctx, pool, repo, emp.ID, "Build", node.RoleUbuntu, []string{"start"})
	if got := defaultPC(t, ctx, pool, emp.ID); got != "" {
		t.Fatalf("Ubuntu 节点被选成默认 PC: %s", got)
	}
	early := mustRegister(t, ctx, pool, repo, emp.ID, "Early", node.RolePC, []string{"start", "input"})
	if got := defaultPC(t, ctx, pool, emp.ID); got != early.NodeID {
		t.Fatalf("最早的 PC 没有成为默认值: %s", got)
	}
	later := mustRegister(t, ctx, pool, repo, emp.ID, "Later", node.RolePC, nil)
	if got := defaultPC(t, ctx, pool, emp.ID); got != early.NodeID {
		t.Fatalf("新增节点改变了默认 PC: %s", got)
	}
	if early.RegistrationSeq >= later.RegistrationSeq || ubuntu.RegistrationSeq >= early.RegistrationSeq {
		t.Fatalf("注册序号没有按提交顺序增长: %d %d %d", ubuntu.RegistrationSeq, early.RegistrationSeq, later.RegistrationSeq)
	}
	if early.EmployeeID != emp.ID || early.Credential.Version != 1 || early.Credential.Token == "" {
		t.Fatal("注册结果缺少归属或连接凭据")
	}
}

func TestConcurrentRegistrationChoosesEarliestPC(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")

	type job struct {
		employee identity.Employee
		token    string
		role     string
		name     string
	}
	var jobs []job
	for _, emp := range []identity.Employee{alice, bob} {
		roles := []string{node.RolePC, node.RoleUbuntu, node.RolePC}
		for i, role := range roles {
			_, token, _, err := repo.IssueEnrollment(ctx, emp.ID, 10*time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			jobs = append(jobs, job{employee: emp, token: token, role: role, name: fmt.Sprintf("%s-%d", emp.Username, i)})
		}
	}

	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errCh := make(chan error, len(jobs))
	for _, job := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.Register(ctx, store.RegisterInput{
				Token:         job.token,
				DisplayName:   job.name,
				System:        node.SystemLinux,
				Role:          job.role,
				Capabilities:  []string{"start"},
				CredentialTTL: 30 * 24 * time.Hour,
			}, signer)
			if err != nil {
				errCh <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
	if t.Failed() {
		return
	}
	for _, emp := range []identity.Employee{alice, bob} {
		got := defaultPC(t, ctx, pool, emp.ID)
		want := earliestPC(t, ctx, pool, emp.ID)
		if got == "" || got != want {
			t.Fatalf("%s 的默认 PC 是 %s，最早有效 PC 是 %s", emp.Username, got, want)
		}
		var owner string
		if err := pool.QueryRow(ctx, `SELECT employee_id::text FROM nodes WHERE id = $1::uuid`, got).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if owner != emp.ID {
			t.Fatalf("%s 的默认 PC 属于 %s", emp.Username, owner)
		}
	}
	before := defaultPC(t, ctx, pool, alice.ID)
	mustRegister(t, ctx, pool, repo, alice.ID, "After", node.RolePC, nil)
	if got := defaultPC(t, ctx, pool, alice.ID); got != before {
		t.Fatalf("并发选定后的新节点改变了默认 PC: %s", got)
	}
}

func TestEnrollmentSingleUseUnderConcurrency(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	emp := mustEmployee(t, ctx, pool, "alice", "Alice")
	_, token, _, err := repo.IssueEnrollment(ctx, emp.ID, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	const n = 4
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, used := 0, 0
	var other error
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := repo.Register(ctx, store.RegisterInput{
				Token:         token,
				DisplayName:   fmt.Sprintf("Race %d", i),
				System:        node.SystemMacOS,
				Role:          node.RolePC,
				Capabilities:  []string{},
				CredentialTTL: 30 * 24 * time.Hour,
			}, signer)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, store.ErrEnrollmentUsed):
				used++
			default:
				other = err
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if other != nil {
		t.Fatal(other)
	}
	if wins != 1 || used != n-1 {
		t.Fatalf("成功 %d，已使用 %d", wins, used)
	}
	var nodes int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM nodes`).Scan(&nodes); err != nil {
		t.Fatal(err)
	}
	if nodes != 1 {
		t.Fatalf("重复使用注册凭据产生了 %d 个节点", nodes)
	}
}

func mustEmployee(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username, display string) identity.Employee {
	t.Helper()
	emp, err := admin.CreateLocal(ctx, pool, username, display, "correct-horse-battery-9")
	if err != nil {
		t.Fatal(err)
	}
	return emp
}

func mustRegister(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *store.Store, employeeID, name, role string, caps []string) node.Identity {
	t.Helper()
	_, token, _, err := repo.IssueEnrollment(ctx, employeeID, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	ident, err := repo.Register(ctx, store.RegisterInput{
		Token:         token,
		DisplayName:   name,
		System:        node.SystemLinux,
		Role:          role,
		Capabilities:  caps,
		CredentialTTL: 30 * 24 * time.Hour,
	}, signer)
	if err != nil {
		t.Fatal(err)
	}
	if ident.EmployeeID != employeeID {
		t.Fatal("节点归属不是注册凭据对应的员工")
	}
	pub, err := signer.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	claims, err := node.VerifyNodeToken(pub, ident.Credential.Token, time.Now())
	if err != nil || claims.NodeID != ident.NodeID || claims.EmployeeID != employeeID || claims.CredentialID != ident.Credential.ID {
		t.Fatal("连接凭据没有绑定节点、员工和 credential_id")
	}
	var n int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM node_credentials
		WHERE id = $1::uuid AND node_id = $2::uuid AND employee_id = $3::uuid
		  AND version = 1 AND revoked_at IS NULL AND expires_at > now()`,
		ident.Credential.ID, ident.NodeID, employeeID).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("数据库没有保存连接凭据摘要")
	}
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM nodes
		WHERE display_name = $1 OR system_name = $1 OR role = $1`, ident.Credential.Token).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("节点记录保存了连接凭据明文")
	}
	var used bool
	err = pool.QueryRow(ctx, `
		SELECT used_at IS NOT NULL FROM node_enrollments WHERE token_hash = $1`, auth.Digest(token)).Scan(&used)
	if err != nil || !used {
		t.Fatal("注册凭据没有被核销")
	}
	return ident
}

func defaultPC(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(default_pc_node_id::text, '')
		FROM employee_settings
		WHERE employee_id = $1::uuid`, employeeID).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func earliestPC(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(ctx, `
		SELECT id::text
		FROM nodes
		WHERE employee_id = $1::uuid AND role = 'pc' AND revoked_at IS NULL
		ORDER BY registration_seq ASC
		LIMIT 1`, employeeID).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
