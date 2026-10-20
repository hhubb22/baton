import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { childEnv, createSessionEmployee, readState, registerNode, repoRoot, spawnDetached, stopPid, trackPid } from './harness.ts'
import type { TaskRecord } from '../src/tasks.ts'

const exec = promisify(execFile)
test('Project 用户派发、运行中取消、暂停恢复及真实 Runtime 的通知输入', async ({ page }) => {
  test.setTimeout(240_000)
  page.setDefaultTimeout(15_000)
  const state = await readState(), account = await createSessionEmployee(state, 'project-control'), password = 'control-replaced-password'
  await page.goto(`${state.baseURL}/projects`)
  const login = async (secret: string) => {
    await page.getByLabel('用户名').fill(account.username)
    await page.getByLabel('口令', { exact: true }).fill(secret)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await login(account.password)
  await page.getByLabel('当前口令').fill(account.password)
  await page.getByLabel('新口令', { exact: true }).fill(password)
  await page.getByLabel('再次输入新口令').fill(password)
  await page.getByRole('button', { name: '更换口令', exact: true }).click()
  await login(password)
  await page.getByLabel('Project 标题').fill('用户直接控制任务')
  await page.getByRole('button', { name: '创建 Project' }).click()
  await expect(page.getByRole('heading', { name: '用户直接控制任务', exact: true })).toBeVisible()
  const projectID = page.url().split('/').at(-1)!, projectURL = `${state.baseURL}/projects/${projectID}`
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? ''), headers = { Origin: state.baseURL, 'X-CSRF-Token': csrf }
  const runnerDir = path.join(state.workDir, 'control-runner'), slowDir = path.join(state.workDir, 'control-slow')
  const enroll = async (name: string, dir: string) => {
    const response = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers, data: {} })
    await registerNode(state, (await response.json() as { enrollment_token: string }).enrollment_token, name, ['pi', 'start', 'input', 'resume'], dir)
    const list = await (await page.request.get(`${state.baseURL}/api/v1/nodes`)).json() as { nodes: { id: string; display_name: string }[] }
    return list.nodes.find((node) => node.display_name === name)!.id
  }
  const targetID = await enroll('直接派发设备', runnerDir), slowID = await enroll('运行中取消设备', slowDir)
  const workspace = path.join(runnerDir, 'work'), slowWorkspace = path.join(slowDir, 'work'), binDir = path.join(state.workDir, 'control-bin'), requestsFile = path.join(state.workDir, 'control-requests.jsonl')
  await mkdir(workspace, { recursive: true }); await mkdir(slowWorkspace, { recursive: true }); await mkdir(binDir, { recursive: true })
  await exec('go', ['build', '-o', path.join(binDir, process.platform === 'win32' ? 'baton-project-runtime.exe' : 'baton-project-runtime'), './internal/gateway/testdata/node_project_runtime.go'], { cwd: repoRoot })
  const start = async (dir: string, extra: Record<string, string>) => {
    const pid = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', dir], childEnv({ BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms', BATON_TEST_EXECUTOR_LOG: path.join(dir, 'executor.log'), ...extra }), path.join(state.logDir, `${path.basename(dir)}.log`))
    await trackPid(pid); return pid
  }
  const runnerPID = await start(runnerDir, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, BATON_TEST_RUNTIME_NODE: process.execPath,
    BATON_TEST_RUNTIME_LOADER: path.join(repoRoot, 'runtimes/project-agent/node_modules/tsx/dist/loader.mjs'), BATON_TEST_RUNTIME_WORKER: path.join(repoRoot, 'runtimes/project-agent/test/user-control-worker.ts'),
    BATON_TEST_CONTROL_REQUESTS: requestsFile, BATON_TEST_CONTROL_TARGET: slowID, BATON_TEST_CONTROL_WORKSPACE: slowWorkspace,
    BATON_TEST_EXECUTOR_SCRIPT: JSON.stringify({ status: 'completed', summary: '用户任务完成', evidence: [], evidence_empty_reason: '流程验证', artifacts: [], artifacts_empty_reason: '流程验证', error: null }),
  })
  const slowPID = await start(slowDir, { BATON_TEST_EXECUTOR_SCRIPT: 'running' })
  const db = new Client({ connectionString: state.databaseURL }); await db.connect(); await db.query(`SET search_path TO "${state.schema}"`)
  const tasks = async () => (await (await page.request.get(`${state.baseURL}/api/v1/tasks?project_id=${projectID}`)).json() as { tasks: TaskRecord[] }).tasks
  const readTask = async (id: string) => await (await page.request.get(`${state.baseURL}/api/v1/tasks/${id}`)).json() as TaskRecord
  const requests = async () => readFile(requestsFile, 'utf8').catch(() => '')
  const settings = async (status: string) => {
    await page.getByText('Project 设置', { exact: true }).click()
    await page.getByLabel('模型订阅', { exact: true }).fill('openai-codex'); await page.getByLabel('模型', { exact: true }).fill('fake-model')
    await page.getByRole('combobox', { name: 'Project 状态', exact: true }).selectOption(status)
    await page.getByRole('button', { name: '保存 Project 设置' }).click(); await expect(page.getByRole('status')).toContainText('已保存')
    await page.getByText('Project 设置', { exact: true }).click()
  }
  const dispatch = async (description: string) => {
    await page.getByText('直接派发任务', { exact: true }).click()
    await page.getByRole('combobox', { name: '节点', exact: true }).selectOption(targetID); await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('pi')
    await page.getByLabel('工作目录', { exact: true }).fill(workspace); await page.getByLabel('任务说明', { exact: true }).fill(description)
    await page.getByLabel('期望产物与验证方式', { exact: true }).fill('检查执行记录和结果摘要')
    await page.getByRole('button', { name: '提交任务', exact: true }).click(); await expect(page.getByRole('link', { name: description, exact: true })).toBeVisible()
    await page.getByText('直接派发任务', { exact: true }).click()
    return (await tasks()).find((task) => task.description === description)!
  }
  const proof = test.info().outputPath('evidence')
  await mkdir(proof, { recursive: true })
  try {
    await settings('active')
    await expect.poll(async () => (await db.query('SELECT count(*) FROM node_runtime_reports WHERE node_id=$1', [targetID])).rows[0].count).toBe('1')
    await page.getByRole('button', { name: '刷新 Project', exact: true }).click()
    const direct = await dispatch('用户直接派发的验证任务')
    await expect.poll(async () => {
      expect((await db.query('SELECT count(*) FROM agent_runs WHERE agent_id=(SELECT id FROM project_agents WHERE project_id=$1)', [projectID])).rows[0].count).toBe('0')
      return (await readTask(direct.task_id)).status
    }).toBe('completed')
    await expect(page.getByRole('region', { name: 'Project 任务' }).getByText('由用户发起')).toBeVisible()
    await page.getByRole('region', { name: 'Project 任务' }).screenshot({ path: path.join(proof, 'user-task.png') })
    expect(await requests()).toBe('')
    await page.getByLabel('发给 Project Agent 的消息').fill('读取我的任务结果，然后派发验证任务'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(requests).toContain(direct.task_id)
    await expect.poll(async () => (await tasks()).find((task) => task.origin_conversation_id)?.status).toBe('running')
    const agentTask = (await tasks()).find((task) => task.origin_conversation_id)!
    await page.getByRole('link', { name: agentTask.description, exact: true }).click(); await page.getByRole('button', { name: '请求取消', exact: true }).click()
    await expect.poll(async () => (await readTask(agentTask.task_id)).status).toBe('cancelled')
    expect((await readTask(agentTask.task_id)).stop_confirmed_at).toBeTruthy()
    await page.getByRole('button', { name: '刷新任务记录' }).click()
    await page.getByRole('region', { name: '执行状态', exact: true }).screenshot({ path: path.join(proof, 'cancelled.png') })
    await expect.poll(async () => (await requests()).includes('user_operation') && (await requests()).includes('cancel')).toBe(true)
    await page.goto(projectURL); await settings('paused')
    const paused = await dispatch('暂停期间直接派发的任务')
    await expect.poll(async () => (await readTask(paused.task_id)).status).toBe('completed')
    await page.goto(`${state.baseURL}/tasks/${agentTask.task_id}`); await page.getByRole('button', { name: '人工核实', exact: true }).click()
    await page.getByLabel('理由', { exact: true }).fill('暂停期间用户核对结果'); await page.getByLabel('结论摘要', { exact: true }).fill('人工核实后的结论')
    await page.getByLabel('无证据原因', { exact: true }).fill('流程验证'); await page.getByRole('button', { name: '保存核实结论' }).click()
    await expect(page.getByRole('status')).toContainText('核实结论已保存')
    await page.goto(projectURL); await page.getByLabel('发给 Project Agent 的消息').fill('恢复后处理暂停期间的输入'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('消息已保存在中心')
    expect((await db.query('SELECT count(*) FROM agent_runs WHERE agent_id=(SELECT id FROM project_agents WHERE project_id=$1) AND ended_at IS NULL', [projectID])).rows[0].count).toBe('0')
    const pending = await db.query('SELECT id FROM project_agent_input_queue WHERE agent_id=(SELECT id FROM project_agents WHERE project_id=$1) AND delivered_seq IS NULL ORDER BY id', [projectID])
    expect(pending.rows).toHaveLength(3)
    await page.getByRole('region', { name: 'Project 运行状态' }).screenshot({ path: path.join(proof, 'paused.png') })
    await settings('active')
    await expect.poll(async () => (await db.query('SELECT count(*) FROM project_agent_input_queue WHERE id=ANY($1::bigint[]) AND delivered_seq IS NULL', [pending.rows.map((row) => row.id)])).rows[0].count).toBe('0')
    await expect.poll(requests).toContain('人工核实后的结论')
    const delivered = await db.query(`SELECT q.id,count(*) FROM project_agent_input_queue q JOIN conversation_events e ON e.conversation_id=(SELECT c.id FROM conversations c JOIN project_agents a ON a.id=c.agent_id WHERE a.project_id=$1) AND e.kind='input' AND e.payload->'input_ids' @> to_jsonb(ARRAY[q.id]) WHERE q.id=ANY($2::bigint[]) GROUP BY q.id`, [projectID, pending.rows.map((row) => row.id)])
    expect(delivered.rows).toHaveLength(3); expect(delivered.rows.every((row) => row.count === '1')).toBe(true)
  } finally {
    for (const task of await tasks().catch(() => [])) {
      if (!task.target_session_id) continue
      const dir = task.target_node_id === slowID ? slowDir : runnerDir
      const log = await readFile(path.join(dir, 'sessions', task.target_session_id, 'worker.log'), 'utf8').catch(() => '')
      const pid = Number(log.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1]); if (pid > 0) await trackPid(pid)
    }
    await db.end(); await stopPid(slowPID); await stopPid(runnerPID)
  }
})
