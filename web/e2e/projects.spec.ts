import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { childEnv, createSessionEmployee, readState, registerNode, repoRoot, spawnDetached, stopPid, trackPid } from './harness.ts'
import type { Project, ProjectStatus } from '../src/projects.ts'
import type { TaskRecord } from '../src/tasks.ts'

const exec = promisify(execFile)

test('Project 主对话：离线排队、模型失败与恢复、流式预览、记忆和任务、停止运行', async ({ page }) => {
  test.setTimeout(240_000)
  const state = await readState()
  const account = await createSessionEmployee(state, 'projects')
  const password = 'project-e2e-replaced-password'
  await page.goto(`${state.baseURL}/projects`)
  await page.getByLabel('用户名').fill(account.username)
  await page.getByLabel('口令', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('当前口令').fill(account.password)
  await page.getByLabel('新口令', { exact: true }).fill(password)
  await page.getByLabel('再次输入新口令').fill(password)
  await page.getByRole('button', { name: '更换口令', exact: true }).click()
  await page.getByLabel('用户名').fill(account.username)
  await page.getByLabel('口令', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('Project 标题').fill('跨设备验证')
  await page.getByRole('button', { name: '创建 Project' }).click()
  await expect(page.getByRole('heading', { name: '跨设备验证', exact: true })).toBeVisible()
  const projectID = page.url().split('/').at(-1)!
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? '')
  const headers = { Origin: state.baseURL, 'X-CSRF-Token': csrf }
  const api = `${state.baseURL}/api/v1/projects/${projectID}`
  const queryStatus = async () => await (await page.request.get(`${api}/status`)).json() as ProjectStatus
  await page.getByText('Project 设置', { exact: true }).click()
  await page.getByLabel('模型订阅', { exact: true }).fill('openai-codex')
  await page.getByLabel('模型', { exact: true }).fill('fake-model')
  await page.getByRole('button', { name: '保存 Project 设置' }).click()
  await expect(page.getByRole('status')).toContainText('已保存')
  const db = new Client({ connectionString: state.databaseURL })
  await db.connect()
  await db.query(`SET search_path TO "${state.schema}"`)
  const proof = process.env.BATON_CAPTURE_PROJECT_EVIDENCE === '1' ? path.join(repoRoot, 'specs/project-agent/evidence/ps-159') : test.info().outputPath('evidence')
  await mkdir(proof, { recursive: true })
  try {
    let sent = 0
    await page.route('**/api/v1/projects/*/messages', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      sent++
      const result = await route.fetch()
      expect(result.status()).toBe(202)
      await route.abort('failed')
    })
    await page.getByLabel('发给 Project Agent 的消息').fill('检查工作并记录设备约定')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: '查询原消息' })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: '查询原消息' }).click()
    await expect(page.getByRole('status')).toContainText('原消息已保存在中心')
    const statusRegion = page.getByRole('region', { name: 'Project 运行状态' })
    await expect(statusRegion).toContainText('所有设备离线')
    await expect(statusRegion).not.toContainText('Project Agent 正在运行')
    expect((await queryStatus()).run).toBeUndefined()
    expect(sent).toBe(1)
    await statusRegion.screenshot({ path: path.join(proof, 'offline.png') })
    await page.unroute('**/api/v1/projects/*/messages')
    const enroll = async (name: string, dir: string) => {
      const response = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers, data: {} })
      const token = (await response.json() as { enrollment_token: string }).enrollment_token
      await registerNode(state, token, name, ['pi', 'start', 'input', 'resume'], dir)
      const nodes = (await (await page.request.get(`${state.baseURL}/api/v1/nodes`)).json() as { nodes: { id: string; display_name: string }[] }).nodes
      return nodes.find((n) => n.display_name === name)!.id
    }
    const runnerDir = path.join(state.workDir, 'project-runtime')
    const workerDir = path.join(state.workDir, 'project-worker')
    const nodeID = await enroll('Project Runtime 测试设备', runnerDir)
    const targetID = await enroll('任务执行设备', workerDir)
    const workspace = path.join(workerDir, 'work')
    await mkdir(workspace, { recursive: true })
    const binDir = path.join(state.workDir, 'project-bin')
    await mkdir(binDir, { recursive: true })
    await exec('go', ['build', '-o', path.join(binDir, process.platform === 'win32' ? 'baton-project-runtime.exe' : 'baton-project-runtime'), './internal/gateway/testdata/node_project_runtime.go'], { cwd: repoRoot })
    const recoveryFile = path.join(state.workDir, 'recover-model')
    const runnerPID = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', runnerDir], childEnv({
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms',
      BATON_TEST_RUNTIME_NODE: process.execPath, BATON_TEST_RUNTIME_LOADER: path.join(repoRoot, 'runtimes/project-agent/node_modules/tsx/dist/loader.mjs'),
      BATON_TEST_RUNTIME_WORKER: path.join(repoRoot, 'runtimes/project-agent/test/web-worker.ts'), BATON_TEST_WEB_RECOVER: recoveryFile, BATON_TEST_WEB_TARGET: targetID, BATON_TEST_WEB_WORKSPACE: workspace,
    }), path.join(state.logDir, 'project-runtime.log'))
    await trackPid(runnerPID)
    // 直接推进退避时钟，三次失败仍由真实 Runtime 和 Coordinator 产生。
    await expect.poll(async () => {
      await db.query(`UPDATE conversations SET next_attempt_at=clock_timestamp() WHERE id=(SELECT conversation_id FROM (SELECT c.id AS conversation_id FROM conversations c JOIN project_agents a ON a.id=c.agent_id WHERE a.project_id=$1) q) AND state='active' AND next_attempt_at IS NOT NULL`, [projectID])
      return (await queryStatus()).state
    }, { timeout: 60_000 }).toBe('needs_attention')
    await page.getByRole('button', { name: '刷新 Project', exact: true }).click()
    await expect(statusRegion).toContainText('最后的错误：model_request_failed')
    await expect(page.getByRole('button', { name: '重试 Project Agent' })).toBeVisible()
    const before = await db.query('SELECT seq,payload FROM conversation_events WHERE conversation_id=(SELECT c.id FROM conversations c JOIN project_agents a ON a.id=c.agent_id WHERE a.project_id=$1) ORDER BY seq', [projectID])
    expect(before.rows).toHaveLength(1)
    expect(before.rows[0].seq).toBe('1')
    await statusRegion.screenshot({ path: path.join(proof, 'needs-attention.png') })
    await writeFile(recoveryFile, 'recover')
    await page.getByRole('button', { name: '重试 Project Agent' }).click()
    await expect(statusRegion).toContainText('当前运行设备：Project Runtime 测试设备')
    const stream = page.getByRole('article', { name: '流式回复' })
    await expect(stream).toBeVisible({ timeout: 60_000 })
    const streamedStatus = await queryStatus()
    expect(streamedStatus.run?.node_id).toBe(nodeID)
    const originalRun = streamedStatus.run!.id
    await statusRegion.screenshot({ path: path.join(proof, 'running.png') })
    await stream.screenshot({ path: path.join(proof, 'streaming.png') })
    const projectTasks = page.getByRole('region', { name: 'Project 任务' })
    await expect(projectTasks.getByText('由 Project Agent 发起')).toBeVisible()
    await expect(projectTasks.getByRole('link', { name: 'Project Agent 派出的验证任务' })).toBeVisible()
    await projectTasks.screenshot({ path: path.join(proof, 'project-tasks.png') })
    const tasks = async () => (await (await page.request.get(`${state.baseURL}/api/v1/tasks?project_id=${projectID}`)).json() as { tasks: TaskRecord[] }).tasks
    const task = (await tasks())[0]!
    expect(task.status).toBe('queued')
    await page.getByRole('button', { name: '停止当前运行' }).click()
    await expect.poll(async () => (await db.query('SELECT end_reason FROM agent_runs WHERE id=$1', [originalRun])).rows[0]?.end_reason).toBe('user_stopped')
    expect((await tasks())[0]?.status).toBe('queued')
    expect((await tasks())[0]?.version).toBe(task.version)
    await expect.poll(async () => (await db.query('SELECT stop_acked_at IS NOT NULL AS stopped FROM agent_runs WHERE id=$1', [originalRun])).rows[0]?.stopped).toBe(true)
    // 已派任务在停止 Project Runtime 后仍可由独立设备执行。
    const workerPID = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', workerDir], childEnv({ BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms', BATON_TEST_EXECUTOR_LOG: path.join(workerDir, 'executor.log'), BATON_TEST_EXECUTOR_SCRIPT: JSON.stringify({ status: 'completed', summary: '任务在 Project Agent 停止后完成', evidence: [], evidence_empty_reason: '流程验证', artifacts: [], artifacts_empty_reason: '流程验证', error: null }) }), path.join(state.logDir, 'project-worker.log'))
    await trackPid(workerPID)
    await expect.poll(async () => (await tasks())[0]?.status).toBe('completed')
    const finishedTask = (await tasks())[0]!
    const workerLog = await readFile(path.join(workerDir, 'sessions', finishedTask.target_session_id!, 'worker.log'), 'utf8')
    const workerProcess = Number(workerLog.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1])
    expect(workerProcess).toBeGreaterThan(0)
    await trackPid(workerProcess)
    await page.getByRole('button', { name: '刷新 Project', exact: true }).click()
    const memories = page.getByRole('region', { name: '项目记忆' })
    await expect(memories.getByText('保留跨设备工作记录')).toBeVisible()
    await memories.getByRole('button', { name: '修改记忆' }).click()
    await memories.getByLabel('记忆内容').first().fill('用户保存的新约定')
    await memories.getByRole('button', { name: '保存记忆' }).first().click()
    await expect(memories.getByText('用户保存的新约定')).toBeVisible()
    await memories.screenshot({ path: path.join(proof, 'memory.png') })
    await projectTasks.getByRole('link', { name: 'Project Agent 派出的验证任务' }).click()
    await expect(page).toHaveURL(`${state.baseURL}/tasks/${task.task_id}`)
    await expect(page.getByText('由 Project Agent 发起')).toBeVisible()
    await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText('停止后完成')
    await page.reload()
    await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText('停止后完成')
    await page.goBack()
    await expect(page.getByRole('heading', { name: '跨设备验证', exact: true })).toBeVisible()
    const final = await db.query('SELECT seq,payload FROM conversation_events WHERE conversation_id=(SELECT c.id FROM conversations c JOIN project_agents a ON a.id=c.agent_id WHERE a.project_id=$1) ORDER BY seq LIMIT 1', [projectID])
    expect(final.rows).toEqual(before.rows)
    expect(await tasks()).toHaveLength(1)
    const record = await (await page.request.get(api)).json() as Project
    const count = await db.query(`SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='user_message'`, [record.agent.id])
    expect(count.rows[0].count).toBe('1')
    await stopPid(workerPID); await stopPid(runnerPID)
  } finally { await db.end() }
})
