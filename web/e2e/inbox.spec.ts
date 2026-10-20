import { expect, test, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { childEnv, createSessionEmployee, readState, registerNode, repoRoot, spawnDetached, stopPid, trackPid } from './harness.ts'
import type { InboxPage } from '../src/inbox.ts'
import type { TaskRecord } from '../src/tasks.ts'
import type { Project } from '../src/projects.ts'

const exec = promisify(execFile)

test('Inbox：真实 Runtime 创建事项，三处处理与轮询、系统解决、版本、预览、引用预填和桌面布局', async ({ page, context }) => {
  test.setTimeout(240_000)
  const state = await readState()
  const account = await createSessionEmployee(state, 'inbox')
  const password = 'inbox-e2e-replaced-password'
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
  await page.getByLabel('Project 标题').fill('Inbox 验证')
  await page.getByRole('button', { name: '创建 Project' }).click()
  await expect(page.getByRole('heading', { name: 'Inbox 验证', exact: true })).toBeVisible()
  const projectID = page.url().split('/').at(-1)!
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? '')
  await context.addInitScript((value) => sessionStorage.setItem('baton_csrf', value), csrf)
  const headers = { Origin: state.baseURL, 'X-CSRF-Token': csrf }
  const projectAPI = `${state.baseURL}/api/v1/projects/${projectID}`
  const project = await (await page.request.get(projectAPI)).json() as Project
  expect((await page.request.patch(projectAPI, { headers, data: { provider: 'openai-codex', model: 'fake-model' } })).ok()).toBe(true)
  const db = new Client({ connectionString: state.databaseURL })
  await db.connect(); await db.query(`SET search_path TO "${state.schema}"`)
  const proof = test.info().outputPath('evidence')
  await mkdir(proof, { recursive: true })
  const binDir = path.join(state.workDir, 'inbox-bin')
  const dataDir = path.join(state.workDir, 'inbox-node')
  const workspace = path.join(dataDir, 'work')
  const ready = path.join(state.workDir, 'inbox-task-ready')
  await mkdir(binDir, { recursive: true }); await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'proof.txt'), '第一行证据\n第二行证据\n第三行证据')
  const enrollment = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers, data: {} })
  await registerNode(state, (await enrollment.json() as { enrollment_token: string }).enrollment_token, 'Inbox 测试设备', ['pi', 'start', 'input', 'resume'], dataDir)
  const nodes = (await (await page.request.get(`${state.baseURL}/api/v1/nodes`)).json() as { nodes: { id: string }[] }).nodes
  const nodeID = nodes[0]!.id
  await exec(state.batondBin, ['files', 'add', '--id', 'proof', '--path', workspace, '--data-dir', dataDir], { env: childEnv({}) })
  await exec('go', ['build', '-o', path.join(binDir, process.platform === 'win32' ? 'baton-project-runtime.exe' : 'baton-project-runtime'), './internal/gateway/testdata/node_project_runtime.go'], { cwd: repoRoot })
  const sha = 'd124e5898208a682fcf606762e134d6ccb5432c8'
  const nodePID = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', dataDir], childEnv({
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms',
    BATON_TEST_RUNTIME_NODE: process.execPath, BATON_TEST_RUNTIME_LOADER: path.join(repoRoot, 'runtimes/project-agent/node_modules/tsx/dist/loader.mjs'), BATON_TEST_RUNTIME_WORKER: path.join(repoRoot, 'runtimes/project-agent/test/inbox-web-worker.ts'),
    BATON_TEST_WEB_TARGET: nodeID, BATON_TEST_WEB_WORKSPACE: workspace, BATON_TEST_INBOX_READY: ready,
    BATON_TEST_EXECUTOR_LOG: path.join(dataDir, 'executor.log'), BATON_TEST_EXECUTOR_SCRIPT: JSON.stringify({ status: 'needs_verification', summary: '原结果：需要核实重连日志', error: { code: 'execution_failed', message: '需要人工核实' }, evidence: [{ node_id: nodeID, storage_ref: 'root:proof', resource_id: 'proof.txt', access_status: 'available', note: '重连证据' }, { storage_ref: 'inspection:123', resource_id: '人工检查记录', access_status: 'unknown' }], artifacts: [{ storage_ref: 'https://github.com/hhubb22/baton.git', resource_id: sha, access_status: 'available' }] }),
  }), path.join(state.logDir, 'inbox-node.log'))
  await trackPid(nodePID)
  const readInbox = async (stateFilter = 'all') => await (await page.request.get(`${state.baseURL}/api/v1/inbox?state=${stateFilter}&project_id=${projectID}`)).json() as InboxPage
  const taskList = async () => (await (await page.request.get(`${state.baseURL}/api/v1/tasks?project_id=${projectID}`)).json() as { tasks: TaskRecord[] }).tasks
  const card = (target: Page, index: number) => target.getByRole('article', { name: `事项：重连检查 ${index}`, exact: true })
  const pages: Page[] = [page]
  try {
    await page.getByLabel('发给 Project Agent 的消息').fill('检查重连并请我决定')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(async () => (await taskList())[0]?.status).toBe('needs_verification')
    const task = (await taskList())[0]!
    const workerLog = await readFile(path.join(dataDir, 'sessions', task.target_session_id!, 'worker.log'), 'utf8')
    const workerPID = Number(workerLog.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1])
    if (workerPID) await trackPid(workerPID)
    await writeFile(ready, task.task_id)
    await expect.poll(async () => (await readInbox()).requests.filter((v) => v.source === 'agent').length).toBe(3)
    const requests = (await readInbox()).requests
    const system = requests.find((v) => v.source === 'system')!
    expect(system).toBeTruthy()
    await expect(card(page, 1)).toBeVisible()
    expect(await card(page, 1).getByRole('table').count()).toBe(1)
    const inbox = await context.newPage(), detail = await context.newPage()
    pages.push(inbox, detail)
    await inbox.goto(`${state.baseURL}/inbox`); await detail.goto(`${state.baseURL}/tasks/${task.task_id}`)
    await expect(inbox.getByRole('button', { name: 'Inbox（4）', exact: true })).toBeVisible()
    await expect(inbox).toHaveTitle('(4) Baton')
    const systemCard = inbox.getByRole('article', { name: `事项：${system.title}`, exact: true })
    await expect(systemCard.getByText(/由 Baton 创建/)).toBeVisible()
    expect(await systemCard.getByRole('button').count()).toBe(1)
    await expect(systemCard.getByRole('link', { name: '打开处理位置' })).toHaveAttribute('href', `/tasks/${task.task_id}`)
    await inbox.setViewportSize({ width: 1024, height: 900 }); await inbox.screenshot({ path: path.join(proof, 'inbox.png'), fullPage: true })
    const sources = [inbox, page, detail]
    const sync: { source: string; elapsed_ms: number }[] = []
    for (const [i, source] of sources.entries()) {
      const index = i + 1
      for (const target of pages) await expect(card(target, index)).toBeVisible()
      await card(source, index).getByRole('radio', { name: /调查并修复/ }).check()
      await card(source, index).getByLabel('补充说明').fill(`来自页面 ${index}`)
      await Promise.all(pages.map((target) => target.evaluate((title) => {
        const timings = window as unknown as { inboxResolvedAt: number }
        timings.inboxResolvedAt = 0
        const observer = new MutationObserver(() => {
          const nodes = Array.from(document.querySelectorAll('.attention-card'))
          if (nodes.some((element) => element.getAttribute('aria-label') === `事项：${title}` && element.textContent?.includes('已回答：调查并修复'))) { timings.inboxResolvedAt = Date.now(); observer.disconnect() }
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }, `重连检查 ${index}`)))
      const submitted = source.waitForResponse((response) => response.url().endsWith('/answer') && response.request().method() === 'POST').then(() => Date.now())
      await card(source, index).getByRole('button', { name: '提交回答' }).click()
      const saved = await submitted
      await Promise.all(pages.map((target) => expect(card(target, index)).toContainText('已回答：调查并修复', { timeout: 5500 })))
      const displayed = await Promise.all(pages.map((target) => target.evaluate(() => (window as unknown as { inboxResolvedAt: number }).inboxResolvedAt)))
      expect(displayed.every((v) => v > 0)).toBe(true)
      sync.push({ source: ['Inbox', 'Project', '任务详情'][i]!, elapsed_ms: Math.max(...displayed) - saved })
      expect(sync.at(-1)!.elapsed_ms).toBeLessThanOrEqual(5000)
    }
    await card(page, 1).screenshot({ path: path.join(proof, 'project-card.png') })
    const inputCount = await db.query("SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='attention_answer'", [project.agent.id])
    expect(inputCount.rows[0].count).toBe('3')
    await expect.poll(async () => (await db.query("SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='input' AND payload::text LIKE '%attention_answer%'", [project.conversation.id])).rows[0].count).not.toBe('0')
    const resolve = await page.request.post(`${state.baseURL}/api/v1/tasks/${task.task_id}/resolve`, { headers, data: { expected_version: task.version, status: 'completed', summary: '人工修正后的结果', reason: '核对完整日志', evidence: task.evidence, evidence_empty_reason: '' } })
    expect(resolve.status()).toBe(200)
    const attentionID = requests.find((v) => v.title === '重连检查 1')!.id
    const attention = await context.newPage(); pages.push(attention)
    await attention.goto(`${state.baseURL}/inbox/${attentionID}`)
    await expect(attention.getByText('原结果：需要核实重连日志', { exact: true })).toBeVisible()
    await expect(attention.getByText(/修正时间/)).toBeVisible()
    await attention.getByRole('button', { name: '查看最新版本' }).click()
    await expect(attention.getByText('人工修正后的结果', { exact: true })).toBeVisible()
    await attention.getByRole('button', { name: '查看原版本' }).click()
    await expect(attention.getByText('原结果：需要核实重连日志', { exact: true })).toBeVisible()
    await expect(inbox.getByRole('region', { name: '待处理', exact: true }).getByRole('article')).toHaveCount(0)
    await expect(systemCard).toContainText('已解决')
    await attention.getByRole('button', { name: '预览', exact: true }).click()
    await expect(attention.getByText(/第一行证据/)).toBeVisible()
    const preview = attention.locator('.task-preview')
    await preview.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range) })
    await preview.locator('..').locator('..').getByRole('button', { name: '问 Project Agent' }).click()
    await expect(attention).toHaveURL(`${state.baseURL}/projects/${projectID}`)
    await expect(attention.getByLabel('发给 Project Agent 的消息')).toHaveValue(/路径 root:proof\/proof.txt；行 1–3/)
    // 重新进入事项，在真实 Markdown DOM 里选中 10 KiB。
    await attention.goto(`${state.baseURL}/inbox/${attentionID}`)
    await attention.locator('.markdown').getByText('q'.repeat(10240), { exact: true }).evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range) })
    const messagesBefore = (await db.query("SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='user_message'", [project.agent.id])).rows[0].count
    await attention.locator('.markdown').locator('..').locator('..').getByRole('button', { name: '问 Project Agent', exact: true }).click()
    const composer = attention.getByLabel('发给 Project Agent 的消息')
    await expect(composer).toHaveValue(/原长度 10240 字节/)
    expect((await composer.inputValue()).split('> ')[1]!.trim()).toHaveLength(8192)
    expect((await db.query("SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='user_message'", [project.agent.id])).rows[0].count).toBe(messagesBefore)
    const edited = `${await composer.inputValue()}请根据这段日志继续调查。`
    await composer.fill(edited)
    await attention.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(async () => (await db.query("SELECT payload->>'content' AS content FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='user_message' ORDER BY id DESC LIMIT 1", [project.agent.id])).rows[0].content).toBe(edited)
    await attention.goto(`${state.baseURL}/inbox/${attentionID}`)
    await attention.setViewportSize({ width: 1024, height: 900 })
    await expect(attention.getByText('原结果：需要核实重连日志', { exact: true })).toBeVisible()
    await attention.screenshot({ path: path.join(proof, 'attention-version.png'), fullPage: true })
    expect(await attention.locator('.markdown img, .markdown script').count()).toBe(0)
    expect(await attention.evaluate(() => 'inboxPwned' in window)).toBe(false)
    const httpsLink = attention.getByRole('link', { name: '详情', exact: true })
    await expect(httpsLink).toHaveAttribute('target', '_blank')
    await stopPid(nodePID)
    await expect(detail.getByRole('region', { name: '节点连接', exact: true })).toContainText('离线')
    await attention.getByRole('button', { name: '预览', exact: true }).click()
    await expect(attention.getByRole('alert')).toContainText('暂不可查看')
    await expect(attention.getByText(/第一行证据/)).toHaveCount(0)
    await expect(attention.getByText(`Commit SHA：${sha}`)).toBeVisible()
    expect(await attention.getByRole('button', { name: '预览', exact: true }).count()).toBe(1)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: state.baseURL })
    await attention.bringToFront()
    await attention.getByRole('button', { name: '复制 SHA' }).click()
    await expect(attention.getByRole('status')).toContainText('已复制 SHA')
    expect(await attention.evaluate(() => navigator.clipboard.readText())).toBe(sha)
    await detail.setViewportSize({ width: 1024, height: 900 }); await detail.getByRole('region', { name: '相关事项', exact: true }).screenshot({ path: path.join(proof, 'task-offline.png') })
    for (const target of pages) {
      await target.setViewportSize({ width: 1024, height: 768 })
      expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    await writeFile(path.join(proof, 'results.json'), JSON.stringify({ sync, input_count: 3, quote_original_bytes: 10240, quote_saved_bytes: 8192, viewport: 1024, assertions: ['system_resolved', 'original_and_latest', 'root_preview', 'offline_no_stale', 'commit_copy', 'draft_edit_send_exact', 'no_html_or_images'] }, null, 2) + '\n')
  } finally { await stopPid(nodePID); await db.end(); for (const target of pages.slice(1)) await target.close() }
})
