package migrate

import "testing"

func TestInboxSourcesUniquenessAndEmployeeForeignKeys(t *testing.T) {
	pool := migratedTestDB(t)
	seedIdentity(t, pool)
	seedProject(t, pool)
	seedThread(t, pool)
	const system = "60000000-0000-4000-8000-000000000001"
	const agent = "60000000-0000-4000-8000-000000000002"
	const duplicate = "60000000-0000-4000-8000-000000000003"
	const systemSQL = `INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,condition_type,condition_object_id,title)
		VALUES($1,$2,$3,$4,$5,'system','project_needs_attention',$3,'需要处理')`
	execOK(t, pool, systemSQL, system, testEmployee, testProject, testAgent, testConversation)
	execFails(t, pool, "23505", systemSQL, duplicate, testEmployee, testProject, testAgent, testConversation)
	execOK(t, pool, `UPDATE attention_requests SET state='resolved' WHERE id=$1`, system)
	execOK(t, pool, systemSQL, duplicate, testEmployee, testProject, testAgent, testConversation)
	const agentSQL = `INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,origin_tool_call_id,thread_id,title)
		VALUES($1,$2,$3,$4,$5,'agent','tool-call',$6,'请确认')`
	execFails(t, pool, "23503", agentSQL, agent, testOtherEmployee, testProject, testAgent, testConversation, testThread)
	execOK(t, pool, agentSQL, agent, testEmployee, testProject, testAgent, testConversation, testThread)
	execFails(t, pool, "23514", `UPDATE attention_requests SET state='resolved' WHERE id=$1`, agent)
	execFails(t, pool, "23514", `UPDATE attention_requests SET state='answered' WHERE id=$1`, duplicate)
	execFails(t, pool, "23514", `UPDATE attention_requests SET thread_id=$1 WHERE id=$2`, testThread, duplicate)
	execFails(t, pool, "23514", `UPDATE attention_requests SET condition_type='task_needs_verification' WHERE id=$1`, duplicate)
	execFails(t, pool, "23514", `UPDATE attention_requests SET options='[1,2,3,4,5,6]' WHERE id=$1`, agent)
}
