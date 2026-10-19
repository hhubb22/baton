import { expect, test, type WebSocketRoute } from '@playwright/test'
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { Client } from 'pg'
import { childEnv, createSessionEmployee, readState, registerNode, repoRoot, spawnDetached, stopPid, trackPid } from './harness.ts'
import type { HistoryResult } from '../src/history-model.ts'

test('节点历史分页、断线补取、缺失反馈与中心隐私', async ({ page }) => {
  let socket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/events', (route) => { socket = route; route.connectToServer() })
  const state = await readState()
  const employee = await createSessionEmployee(state, 'history')
  const password = 'history-replaced-secret'
  await page.goto(state.baseURL)
  await page.getByLabel('用户名').fill(employee.username)
  await page.getByLabel('口令', { exact: true }).fill(employee.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('当前口令').fill(employee.password)
  await page.getByLabel('新口令', { exact: true }).fill(password)
  await page.getByLabel('再次输入新口令').fill(password)
  await page.getByRole('button', { name: '更换口令', exact: true }).click()
  await page.getByLabel('用户名').fill(employee.username)
  await page.getByLabel('口令', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByTestId('current-user')).toBeVisible()
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? '')
  const enrolled = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers: { Origin: state.baseURL, 'X-CSRF-Token': csrf }, data: {} })
  const { enrollment_token: token } = await enrolled.json() as { enrollment_token: string }
  const dataDir = path.join(state.workDir, 'history-node')
  const workspace = path.join(dataDir, 'work')
  await registerNode(state, token, 'History Node', ['pi', 'start', 'history'], dataDir)
  await mkdir(workspace, { recursive: true })
  const marker = `LOCAL_HISTORY_${crypto.randomUUID()}`
  await writeFile(path.join(workspace, 'history-probe.txt'), marker)
  const native = process.env.BATON_REAL_PI_BROWSER === '1'
  const fixture = path.join(state.workDir, 'pi-history-replay')
  const tape = path.join(state.workDir, 'history-events.jsonl')
  const final = JSON.stringify({ status: 'completed', summary: '历史测试完成', evidence: [], evidence_empty_reason: '历史分页验证', artifacts: [], artifacts_empty_reason: '无产物', error: null })
  if (!native) {
    await promisify(execFile)('go', ['test', '-c', '-o', fixture, './internal/agent/pi'], { cwd: repoRoot })
    await writeFile(tape, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${marker}<script>window.historyPwned=true</script>` }], stopReason: 'stop' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: final }], stopReason: 'stop' } },
      { type: 'agent_settled', aborted: false },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
  const nodePID = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', dataDir], childEnv({
    BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms', BATON_AGENT_DRIVER: 'native',
    ...(native ? { BATON_PI_MODEL: process.env.BATON_PI_MODEL ?? 'openai/gpt-6.1-sol' } : { BATON_PI_BIN: fixture, BATON_PI_REPLAY_CHILD: '1', BATON_PI_REPLAY_FIXTURE: tape }),
  }), path.join(state.logDir, 'history-node.log'))
  await trackPid(nodePID)
  await expect(page.locator('[data-display-name="History Node"]').getByTestId('node-presence')).toHaveText('在线')
  await page.getByRole('button', { name: 'Session', exact: true }).click()
  await page.getByText('启动任务', { exact: true }).click()
  await page.getByLabel('工作目录').fill(workspace)
  await page.getByLabel('任务说明').fill(native ? '仅在当前工作目录用 bash 执行 cat history-probe.txt，读取后直接提交完成结果。summary 固定写 历史测试完成，不要复述文件内容；evidence 和 artifacts 都使用空数组，两个 empty_reason 都写 本次只验证历史。不要访问其他目录或网络。' : '执行历史验证任务')
  await page.getByRole('button', { name: '提交任务', exact: true }).click()
  await expect.poll(async () => {
    const result = await (await page.request.get(`${state.baseURL}/api/v1/tasks`)).json() as { tasks: { status: string }[] }
    return result.tasks[0]?.status
  }).toBe('completed')
  const sessions = await (await page.request.get(`${state.baseURL}/api/v1/sessions`)).json() as { sessions: { session_id: string }[] }
  const sid = sessions.sessions[0]!.session_id
  await page.getByRole('button', { name: `pi · ${sid}`, exact: true }).click()
  const history = page.getByRole('region', { name: '节点历史', exact: true })
  await expect(history.getByLabel('历史条目').filter({ hasText: marker })).toHaveCount(1)
  expect(await page.evaluate(() => 'historyPwned' in window)).toBe(false)
  await expect(history.locator('script,img')).toHaveCount(0)
  const sessionDir = path.join(dataDir, 'sessions', sid)
  const mapping = JSON.parse(await readFile(path.join(sessionDir, 'native', 'baton-pi.json'), 'utf8')) as { file: string }
  const workerLog = await readFile(path.join(sessionDir, 'worker.log'), 'utf8')
  const workerPID = Number(workerLog.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1])
  expect(workerPID).toBeGreaterThan(0)
  await trackPid(workerPID)
  await stopPid(workerPID)
  // 已结束 Worker 的原生文件加入分支样本，历史查询必须保持只读且不重启 Worker。
  await appendFile(mapping.file, JSON.stringify({ type: 'branch_summary', id: 'branch-a', parentId: 'root', summary: '断流补取标记' }) + '\n')
  expect(socket).toBeDefined()
  await socket?.close({ code: 1012, reason: '历史补取测试' })
  await expect(page.getByText('实时连接已断开', { exact: false })).toBeVisible()
  await expect(history.getByLabel('历史条目').filter({ hasText: '断流补取标记' })).toHaveCount(1)
  await expect(history.getByText('branch_summary · branch-a · 父条目 root')).toBeVisible()
  const large = JSON.stringify({ type: 'message', id: 'large', parentId: 'branch-a', message: { role: 'toolResult', content: '大'.repeat(20000) } })
  await appendFile(mapping.file, large + '\n' + Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'message', id: `entry-${i}`, parentId: 'branch-a', message: { role: 'user', content: `分页内容 ${i}` } })).join('\n') + '\n')
  let cursor = '', count = 0, maxBytes = 0, truncated = 0
  for (let n = 0; n < 100; n++) {
    const result = await page.request.get(`${state.baseURL}/api/v1/sessions/${sid}/history?limit=2&cursor=${encodeURIComponent(cursor)}`)
    expect(result.headers()['cache-control']).toBe('no-store')
    const body = await result.body()
    maxBytes = Math.max(maxBytes, body.length)
    const parsed = JSON.parse(body.toString()) as HistoryResult
    expect(parsed.ok).toBe(true)
    expect(parsed.history!.entries.length).toBeLessThanOrEqual(2)
    count += parsed.history!.entries.length
    truncated += parsed.history!.entries.filter((e) => e.truncated).length
    cursor = parsed.history!.cursor
    if (!parsed.history!.has_more) break
  }
  expect(count).toBeGreaterThan(42)
  expect(truncated).toBeGreaterThan(0)
  expect(maxBytes).toBeLessThan(16 * 1024)
  await history.getByRole('button', { name: '补取节点历史' }).click()
  await expect(history.getByText(/内容超出单条显示上限/)).toBeVisible()
  await expect(history.getByText(/历史存在截断/)).toBeVisible()
  // 对所有中心业务表和诊断日志检查仅存在于工具输出的随机标记。
  const db = new Client({ connectionString: state.databaseURL })
  await db.connect()
  try {
    const tables = await db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1', [state.schema])
    for (const { tablename } of tables.rows) {
      const ident = (s: string) => `"${s.replaceAll('"', '""')}"`
      const found = await db.query<{ count: string }>(`SELECT count(*) FROM ${ident(state.schema)}.${ident(tablename)} t WHERE row_to_json(t)::text LIKE $1`, [`%${marker}%`])
      expect(found.rows[0]?.count, `中心表 ${tablename} 保存了历史原文`).toBe('0')
    }
  } finally { await db.end() }
  for (const name of await readdir(state.logDir)) {
    if (name.endsWith('.log')) expect((await readFile(path.join(state.logDir, name), 'utf8')).includes(marker)).toBe(false)
  }
  expect((await readFile(path.join(sessionDir, 'worker.log'), 'utf8')).includes(marker)).toBe(false)
  expect((await readFile(path.join(sessionDir, 'worker.log'), 'utf8')).match(/event=worker_listening/g)).toHaveLength(1)
  await unlink(mapping.file)
  await history.getByRole('button', { name: '补取节点历史' }).click()
  await expect(history.getByText('节点本地历史缺失或与原 Session 不匹配。')).toBeVisible()
  await expect(history.getByText(/历史存在截断/)).toBeVisible()
  await stopPid(nodePID)
  await expect.poll(async () => {
    const result = await (await page.request.get(`${state.baseURL}/api/v1/sessions/${sid}/history`)).json() as HistoryResult
    return result.code
  }).toBe('node_offline')
  await history.getByRole('button', { name: '补取节点历史' }).click()
  await expect(history.getByText('节点离线，历史暂不可取回。')).toBeVisible()
  console.log(`历史验证：${native ? '真实 Pi' : '协议子进程'}，${count} 条，HTTP 响应最大 ${maxBytes} 字节，中心表和诊断日志均无原生标记`)
})
