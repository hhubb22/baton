import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { childEnv, readState, registerNode, spawnDetached, stopPid, trackPid } from './harness.ts'
import type { TaskRecord } from '../src/tasks.ts'

const exec = promisify(execFile)

test('真实任务提交、响应丢失、取消、核实冲突及显式新执行', async ({ page }) => {
  const state = await readState()
  const native = process.env.BATON_REAL_PI_TASKS === '1'
  const malicious = '<script>window.taskPwned=true</script><img src=x onerror="window.taskPwned=true">'
  const description = native ? `仅在工作目录内操作。使用 bash 执行一次 printf 'executed\\n' >> task-count.txt。不要访问其他目录或网络。完成后结构化结果的 summary 必须原样包含 ${JSON.stringify(malicious)}；evidence 和 artifacts 均为空数组，evidence_empty_reason 和 artifacts_empty_reason 均写 本次验证任务页面。` : 'PS126 检查任务'
  const username = 'tasks'
  const issued = await exec(state.coordBin, ['admin', 'employee', 'create', '--username', username, '--display-name', '任务测试'], { env: childEnv({ BATON_DATABASE_URL: state.databaseURL, BATON_DB_SCHEMA: state.schema }) })
  const initial = issued.stdout.match(/one_time_password=(\S+)/)?.[1] ?? ''
  const password = 'tasks-replaced-secret'
  await page.goto(`${state.baseURL}/tasks`)
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('口令', { exact: true }).fill(initial)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('当前口令').fill(initial)
  await page.getByLabel('新口令', { exact: true }).fill(password)
  await page.getByLabel('再次输入新口令').fill(password)
  await page.getByRole('button', { name: '更换口令', exact: true }).click()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('口令', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible()
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? '')
  const headers = { Origin: state.baseURL, 'X-CSRF-Token': csrf }
  const enrollment = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers, data: {} })
  const token = (await enrollment.json() as { enrollment_token: string }).enrollment_token
  const dataDir = `${state.workDir}/tasks-node`
  const workspace = `${dataDir}/work`
  await registerNode(state, token, 'Task Node', ['pi', 'start', 'input', 'resume'], dataDir)
  await mkdir(workspace, { recursive: true })
  let submissions = 0
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    submissions++
    const accepted = await route.fetch()
    expect(accepted.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByText('发起任务', { exact: true }).click()
  await page.getByLabel('工作目录').fill(workspace)
  await page.getByLabel('任务说明').fill(description)
  await page.getByLabel('授权范围').fill('只在当前工作目录检查')
  await page.getByRole('button', { name: '提交任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询原请求' })).toBeVisible()
  await page.reload()
  await page.getByText('发起任务', { exact: true }).click()
  await page.getByRole('button', { name: '查询原请求' }).click()
  await expect(page.getByRole('region', { name: '执行状态', exact: true })).toContainText('待执行（已接受，尚未确认启动）')
  await expect(page.getByRole('region', { name: '节点连接', exact: true })).toContainText('离线')
  expect(submissions).toBe(1)
  const originalID = page.url().split('/').at(-1)!
  const readTask = async (id: string) => await (await page.request.get(`${state.baseURL}/api/v1/tasks/${id}`)).json() as TaskRecord
  await page.getByRole('button', { name: '请求取消', exact: true }).click()
  await expect(page.getByRole('region', { name: '执行状态', exact: true })).toContainText('取消')
  await page.getByRole('button', { name: '人工核实', exact: true }).click()
  await page.getByLabel('理由', { exact: true }).fill('本页核对')
  await page.getByLabel('结论摘要').fill('本页旧结论')
  await page.getByLabel('无证据原因').fill('离线核对')
  const cancelled = await readTask(originalID)
  const correction = await page.request.post(`${state.baseURL}/api/v1/tasks/${originalID}/resolve`, { headers, data: { expected_version: cancelled.version, status: 'failed', summary: '另一位审查者保存的新记录', reason: '已核对未启动', evidence: [], evidence_empty_reason: '排队记录' } })
  expect(correction.status()).toBe(200)
  await page.getByRole('button', { name: '保存核实结论' }).click()
  await expect(page.getByRole('alert')).toContainText('任务版本已变化')
  await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText('另一位审查者保存的新记录')
  let reruns = 0
  let rerunRequest = ''
  await page.route('**/api/v1/tasks/*/rerun', async (route) => {
    reruns++
    rerunRequest = (route.request().postDataJSON() as { request_id: string }).request_id
    const result = await route.fetch()
    expect(result.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '发起新执行', exact: true }).click()
  await page.getByLabel('理由', { exact: true }).fill('节点恢复后进行一次检查')
  await page.getByRole('button', { name: '确认发起新执行' }).click()
  await expect(page.getByRole('button', { name: '查询操作结果' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '查询操作结果' }).click()
  await expect(page).not.toHaveURL(new RegExp(originalID))
  const newID = page.url().split('/').at(-1)!
  expect(reruns).toBe(1)
  expect((await readTask(newID)).request_id).toBe(rerunRequest)
  const pid = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', dataDir], childEnv({
    BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms', BATON_TEST_EXECUTOR_LOG: `${dataDir}/executor.log`,
    ...(native ? { BATON_AGENT_DRIVER: 'native', BATON_PI_MODEL: process.env.BATON_PI_MODEL ?? 'openai/gpt-6.1-sol' } : {}),
    BATON_TEST_EXECUTOR_SCRIPT: JSON.stringify({ status: 'completed', summary: malicious, evidence: [], evidence_empty_reason: '浏览器文本验证', artifacts: [], artifacts_empty_reason: '无文件产物', error: null }),
  }), `${state.logDir}/tasks-node.log`)
  await trackPid(pid)
  await expect(page.getByRole('region', { name: '执行状态', exact: true })).toContainText('完成')
  await expect(page.getByRole('region', { name: '结果交付', exact: true })).toContainText('结果已保存在中心')
  await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText(malicious)
  expect(await page.evaluate(() => 'taskPwned' in window)).toBe(false)
  expect(await page.locator('.tasks script, .tasks img').count()).toBe(0)
  const completed = await readTask(newID)
  const workerLog = await readFile(`${dataDir}/sessions/${completed.target_session_id}/worker.log`, 'utf8')
  const workerPID = Number(workerLog.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1])
  expect(workerPID).toBeGreaterThan(0)
  await trackPid(workerPID)
  await writeFile(`${workspace}/proof.txt`, 'PS126 真实证据内容', { mode: 0o600 })
  await exec(state.batondBin, ['files', 'add', '--id', 'proof', '--path', workspace, '--data-dir', dataDir], { env: childEnv({}) })
  await page.getByRole('button', { name: '人工核实', exact: true }).click()
  await page.getByLabel('理由', { exact: true }).fill('核对工作目录中的证据')
  await page.getByLabel('结论摘要').fill(malicious)
  await page.getByLabel('证据引用', { exact: true }).fill('proof.txt')
  await page.getByLabel('证据位置（存储引用）').fill('root:proof')
  await page.getByLabel('证据所在节点').fill(completed.target_node_id)
  await page.getByRole('button', { name: '保存核实结论' }).click()
  await expect(page.getByRole('status')).toContainText('核实结论已保存')
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.getByText('PS126 真实证据内容', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  const count = async () => (await readFile(native ? `${workspace}/task-count.txt` : `${dataDir}/executor.log`, 'utf8')).split('\n').filter((line) => line === (native ? 'executed' : 'input')).length
  expect(await count()).toBe(1)
  let unexpectedWrites = 0
  await page.route('**/api/v1/tasks/**', async (route) => {
    if (route.request().method() !== 'GET') unexpectedWrites++
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '刷新任务记录' }).click()
  await expect(page.getByRole('alert').first()).toContainText('保留上次读取的记录')
  await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText(malicious)
  expect(unexpectedWrites).toBe(0)
  expect(await count()).toBe(1)
  await page.unroute('**/api/v1/tasks/**')
  await stopPid(pid)
  await page.getByRole('button', { name: '刷新任务记录' }).click()
  await expect(page.getByRole('region', { name: '节点连接', exact: true })).toContainText('离线')
  await expect(page.getByRole('region', { name: '执行状态', exact: true })).toContainText('完成')
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂不可查看')
  const client = new Client({ connectionString: state.databaseURL })
  await client.connect()
  try { await client.query(`SET search_path TO "${state.schema}"`); await client.query(`UPDATE "${state.schema}".tasks SET agent_type='shell' WHERE id=$1`, [originalID]) } finally { await client.end() }
  await page.getByRole('link', { name: '所有任务', exact: true }).click()
  await expect(page.getByRole('link', { name: description, exact: true })).toHaveCount(1)
  await page.getByLabel('显示命令任务（shell）').check()
  await expect(page.getByRole('link', { name: description, exact: true })).toHaveCount(2)
  await page.goto(`${state.baseURL}/tasks/${newID}`)
  await expect(page.getByRole('region', { name: '结果摘要', exact: true })).toContainText(malicious)
  await page.setViewportSize({ width: 1024, height: 768 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await count()).toBe(1)
  expect(submissions).toBe(1)
  expect(reruns).toBe(1)
  await page.unroute('**/api/v1/tasks')
  let lostBeforeServer = true
  const recoveryIDs: string[] = []
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    recoveryIDs.push((route.request().postDataJSON() as { request_id: string }).request_id)
    if (lostBeforeServer) { lostBeforeServer = false; await route.abort('failed'); return }
    await route.continue()
  })
  await page.getByRole('link', { name: '所有任务', exact: true }).click()
  await page.getByText('发起任务', { exact: true }).click()
  await page.getByLabel('工作目录').fill(workspace)
  await page.getByLabel('任务说明').fill('未送达请求恢复')
  await page.getByRole('button', { name: '提交任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询原请求' })).toBeVisible()
  await page.reload()
  await page.getByText('发起任务', { exact: true }).click()
  await page.getByRole('button', { name: '查询原请求' }).click()
  await expect(page.getByRole('alert')).toContainText('中心暂未查到原请求')
  await page.getByRole('button', { name: '补全原请求后重发' }).click()
  await page.getByLabel('工作目录').fill(workspace)
  await page.getByLabel('任务说明').fill('未送达请求恢复')
  await page.getByRole('button', { name: '提交原请求', exact: true }).click()
  await expect(page.getByRole('heading', { name: '未送达请求恢复' })).toBeVisible()
  expect(recoveryIDs).toHaveLength(2)
  expect(recoveryIDs[0]).toBe(recoveryIDs[1])
  await page.getByRole('button', { name: '请求取消', exact: true }).click()
  await expect(page.getByRole('region', { name: '执行状态', exact: true })).toContainText('取消')
  expect(await count()).toBe(1)
})
