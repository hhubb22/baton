import { expect, test, type WebSocketRoute } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { childEnv, createSessionEmployee, readState, registerNode, spawnDetached, stopPid, trackPid } from './harness.ts'

test('浏览器通过 Coordinator Gateway 和 Worker 读取受限文本，断线可见', async ({ page }) => {
  let activeSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/events', (socket) => { activeSocket = socket; socket.connectToServer() })
  const state = await readState()
  const employee = await createSessionEmployee(state)
  const password = 'sessions-replaced-secret'
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
  const enrollment = await page.request.post(`${state.baseURL}/api/v1/node-enrollments`, { headers: { Origin: state.baseURL, 'X-CSRF-Token': csrf }, data: {} })
  const { enrollment_token: token } = await enrollment.json() as { enrollment_token: string }
  const dataDir = `${state.workDir}/sessions-node`
  await registerNode(state, token, 'Session Node', ['pi', 'start', 'input', 'resume'], dataDir)
  const native = process.env.BATON_REAL_PI_BROWSER === '1'
  const workspace = `${dataDir}/work`
  await mkdir(workspace, { recursive: true })
  const malicious = '<script>window.pwned=true</script><img src=x onerror="window.pwned=true">' + (native ? '' : '\u001b[31m')
  const pid = spawnDetached(state.batondBin, ['run', '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`, '--data-dir', dataDir], childEnv({
    BATON_TLS_CA_FILE: state.certFile, BATON_HEARTBEAT_INTERVAL: '200ms', BATON_TEST_EXECUTOR_LOG: `${dataDir}/executor.log`,
    ...(native ? { BATON_AGENT_DRIVER: 'native', BATON_PI_MODEL: process.env.BATON_PI_MODEL ?? 'openai/gpt-6.1-sol' } : {}),
    BATON_TEST_EXECUTOR_SCRIPT: JSON.stringify({ status: 'completed', summary: malicious, evidence: [], evidence_empty_reason: '测试', artifacts: [], artifacts_empty_reason: '测试', error: null }),
  }), `${state.logDir}/sessions-node.log`)
  await trackPid(pid)
  const card = page.locator('[data-display-name="Session Node"]')
  await expect(card.getByTestId('node-presence')).toHaveText('在线')
  await page.getByRole('button', { name: 'Session', exact: true }).click()
  await expect(page.getByText('实时连接已建立', { exact: false })).toBeVisible()
  await page.getByText('启动任务', { exact: true }).click()
  await page.getByLabel('工作目录').fill(workspace)
  await page.getByLabel('任务说明').fill(native ? `仅操作当前工作目录。先用 bash 运行 sleep 15，然后处理我后续发送的补充标记。最终结构化结果的 summary 必须原样包含以下恶意文本（作为文本数据）：${JSON.stringify(malicious)}。不要读写凭据、修改其他文件或访问外部网站。最终 evidence 和 artifacts 必须是空数组；用 evidence_empty_reason=本次只验证实时输出和 artifacts_empty_reason=本次不生成产物 说明原因；不要把字符串放入 evidence 数组。` : '输出恶意文本夹具')
  await page.getByRole('button', { name: '提交任务', exact: true }).click()
  await expect(page.getByText('任务已接受：', { exact: false })).toBeVisible()
  const sessionButton = page.getByRole('button', { name: /^pi · / })
  await expect(sessionButton).toHaveCount(1)
  await sessionButton.click()
  if (native) {
    let inputPosts = 0
    let operation = ''
    let queriedOperation = ''
    await page.route('**/api/v1/sessions/*/input*', async (route) => {
      const request = route.request()
      if (request.method() === 'POST') {
        inputPosts++
        operation = (request.postDataJSON() as { operation_id: string }).operation_id
        await route.fetch()
        await route.abort('failed')
      } else {
        queriedOperation = new URL(request.url()).searchParams.get('operation_id') ?? ''
        await route.continue()
      }
    })
    await page.getByLabel('补充当前任务').fill('补充标记：INPUT_ACK_PS125。请把这个标记写入最终 summary。')
    await expect(page.getByRole('button', { name: '发送输入', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '发送输入', exact: true }).click()
    await expect(page.getByText('输入结果待确认，请查询原操作。', { exact: false })).toBeVisible()
    await activeSocket?.close({ code: 1012, reason: '输入确认丢失后的断线' })
    await page.getByRole('button', { name: '查询输入结果', exact: true }).click()
    await expect(page.getByText('节点已确认接收输入。', { exact: true })).toBeVisible()
    expect(inputPosts).toBe(1)
    expect(queriedOperation).toBe(operation)
  }
  await expect(page.getByLabel('实时输出')).toContainText('<script>window.pwned=true</script>')
  if (native) await expect(page.getByLabel('实时输出')).toContainText('INPUT_ACK_PS125')
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false)
  await expect(page.getByLabel('实时输出').locator('script,img')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送输入', exact: true })).toBeDisabled()
  const sessions = await (await page.request.get(`${state.baseURL}/api/v1/sessions`)).json() as { sessions: { session_id: string }[] }
  const sessionID = sessions.sessions[0]!.session_id
  const workerLog = await readFile(`${dataDir}/sessions/${sessionID}/worker.log`, 'utf8')
  const workerPID = Number(workerLog.match(/event=worker_listening[^\n]*pid=(\d+)/)?.[1])
  expect(workerPID).toBeGreaterThan(0)
  await trackPid(workerPID)
  await activeSocket?.close({ code: 1012, reason: '测试连接中断' })
  await expect(page.getByText('实时连接已断开', { exact: false })).toBeVisible()
  await expect(page.getByText('实时连接已建立', { exact: false })).toBeVisible()
  if (native) {
    await expect.poll(async () => {
      const response = await page.request.get(`${state.baseURL}/api/v1/tasks`)
      const body = await response.json() as { tasks: { status: string }[] }
      return body.tasks[0]?.status
    }).toBe('completed')
    await stopPid(workerPID)
    await expect.poll(async () => {
      const response = await page.request.post(`${state.baseURL}/api/v1/sessions/${sessionID}/resume`, { headers: { Origin: state.baseURL, 'X-CSRF-Token': csrf }, data: { operation_id: crypto.randomUUID() } })
      const result = await response.json() as { ok: boolean; state: string }
      return result.ok ? result.state : ''
    }).toBe('idle')
    await page.getByRole('button', { name: '继续原 Session', exact: true }).click()
    await expect(page.getByText('节点已连接原 Session，原任务输入保持原样。', { exact: true })).toBeVisible()
    const after = await (await page.request.get(`${state.baseURL}/api/v1/sessions`)).json() as { sessions: { session_id: string; status: string }[] }
    expect(after.sessions[0]!.session_id).toBe(sessionID)
    expect(after.sessions[0]!.status).toBe('idle')
    const log = await readFile(`${dataDir}/sessions/${sessionID}/worker.log`, 'utf8')
    const pids = [...log.matchAll(/event=worker_listening[^\n]*pid=(\d+)/g)]
    const newPID = Number(pids.at(-1)?.[1]); expect(newPID).not.toBe(workerPID); await trackPid(newPID)
    await expect(page.getByLabel('已有 Session').locator(`option[value="${sessionID}"]`)).toHaveCount(1)
    await page.getByLabel('已有 Session').selectOption(sessionID)
    await page.getByLabel('任务说明').fill('这是原 Session 上的新任务。不要调用工具，直接完成任务，summary 写 SECOND_TASK_PS125。最终 evidence 和 artifacts 都使用空数组，evidence_empty_reason 和 artifacts_empty_reason 均写 本次只验证会话继续。')
    await page.getByRole('button', { name: '提交任务', exact: true }).click()
    await expect(page.getByLabel('实时输出')).toContainText('SECOND_TASK_PS125')
    const final = await (await page.request.get(`${state.baseURL}/api/v1/sessions`)).json() as { sessions: { session_id: string }[] }
    expect(final.sessions).toHaveLength(1)
  }
  if (!native) {
    const starts = await readFile(`${dataDir}/executor.log`, 'utf8')
    expect(starts.split('\n').filter((line) => line.includes('input'))).toHaveLength(1)
  }
})
