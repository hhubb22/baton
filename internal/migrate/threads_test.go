package migrate

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func seedThread(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	execOK(t, pool, `INSERT INTO threads(id,employee_id,client_thread_id,request_hash,node_id,agent_type,working_directory,created_by,model)
		VALUES($1,$2,'thread',decode(repeat('00',32),'hex'),$3,'pi','/src','employee','model-a')`, testThread, testEmployee, testNode)
}

func TestThreadConstraintsAndEmployeeForeignKeys(t *testing.T) {
	pool := migratedTestDB(t)
	seedIdentity(t, pool)
	seedThread(t, pool)
	const turn = "60000000-0000-4000-8000-000000000001"
	const message = "70000000-0000-4000-8000-000000000001"
	execOK(t, pool, `INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,started_at,model)
		VALUES($1,$2,$3,1,'employee',now(),'model-b')`, turn, testEmployee, testThread)
	const messageSQL = `INSERT INTO thread_messages(id,employee_id,thread_id,client_message_id,sender,content,turn_id,worker_turn_seq,model)
		VALUES($1,$2,$3,'message','employee','hello',$4,1,'model-b')`
	execFails(t, pool, "23503", messageSQL, message, testOtherEmployee, testThread, turn)
	execOK(t, pool, messageSQL, message, testEmployee, testThread, turn)
	execFails(t, pool, "23503", `UPDATE thread_messages SET worker_turn_seq=2 WHERE id=$1`, message)
	execFails(t, pool, "23514", `UPDATE thread_messages SET turn_id=NULL WHERE id=$1`, message)
	const outboxSQL = `INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action) VALUES($1,$2,$3,$4,'open')`
	execFails(t, pool, "23503", outboxSQL, testOtherEmployee, testThread, testNode, message)
	execOK(t, pool, outboxSQL, testEmployee, testThread, testNode, message)
	execFails(t, pool, "23505", outboxSQL, testEmployee, testThread, testNode, message)
	execFails(t, pool, "23505", `INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,started_at)
		VALUES($1,$2,$3,2,'employee',now())`, message, testEmployee, testThread)
	for _, table := range []string{"threads", "thread_messages", "thread_turns"} {
		execOK(t, pool, "UPDATE "+table+" SET model=$1", strings.Repeat("m", 512))
		execFails(t, pool, "23514", "UPDATE "+table+" SET model=$1", strings.Repeat("m", 513))
	}
	execFails(t, pool, "23514", `UPDATE thread_messages SET status_reason=$1`, strings.Repeat("x", 4097))
	execFails(t, pool, "23514", `UPDATE threads SET request_hash=decode('00','hex')`)
	execOK(t, pool, `INSERT INTO thread_reports(employee_id,thread_id,event_id,worker_seq,payload_hash,ack)
		VALUES($1,$2,$3,1,decode(repeat('00',32),'hex'),'{}')`, testEmployee, testThread, message)
	execFails(t, pool, "23514", `UPDATE thread_reports SET payload_hash=decode('00','hex')`)
	execOK(t, pool, `INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id) VALUES($1,$2,'thread.opened','node',$3)`, testEmployee, testThread, testNode)
	execFails(t, pool, "23514", `UPDATE thread_events SET kind='changed'`)
	execFails(t, pool, "23514", `DELETE FROM thread_events`)
	const replySQL = `INSERT INTO thread_replies(id,employee_id,thread_id,worker_seq,turn_id,worker_turn_seq,content,original_bytes,metadata)
		VALUES($1,$2,$3,1,$4,1,$5,0,$6)`
	content := strings.Repeat("x", 45056)
	execFails(t, pool, "23514", replySQL, message, testEmployee, testThread, turn, content, `{}`)
	execOK(t, pool, replySQL, message, testEmployee, testThread, turn, content, `{"encoding":"base64"}`)
	execFails(t, pool, "23514", `UPDATE thread_replies SET content=content||'x'`)
}
