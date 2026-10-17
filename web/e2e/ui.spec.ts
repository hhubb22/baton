import { execFile } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { expect, request as apiRequest, test, type Page } from '@playwright/test'
import {
  assertLogsClean,
  childEnv,
  readState,
  registerNode,
  restartRelay,
  startBatond,
  stopPid,
  trackPid,
  waitForPortClosed,
} from './harness.ts'

const aliceNext = 'alice-replaced-secret'
const bobNext = 'bob-replaced-secret'

test('员工可以登录、管理节点并看到真实的吊销结果', async ({ page, browser }) => {
  const state = await readState()
  const secrets = [state.alice.password, state.bob.password, aliceNext, bobNext, state.controlToken, state.databaseURL]
  const consoleText: string[] = []
  page.on('console', (msg) => consoleText.push(msg.text()))
  page.on('request', (req) => {
    for (const secret of secrets) {
      if (secret.length >= 8 && req.url().includes(secret)) throw new Error('请求 URL 包含凭据')
    }
  })

  await page.goto(`${state.baseURL}/`)
  await expect(page.getByTestId('login-form')).toBeVisible()
  await changeInitialPassword(page, state.alice.username, state.alice.password, aliceNext)
  await login(page, state.alice.username, aliceNext)
  await expect(page.getByTestId('current-user')).toContainText('Alice')
  await expect(page.getByTestId('node-list')).toContainText('还没有节点')
  const csrf = await page.evaluate(() => sessionStorage.getItem('baton_csrf') ?? '')
  secrets.push(csrf)

  const deskDir = `${state.workDir}/desk`
  const deskToken = await issueToken(page, secrets)
  await registerNode(state, deskToken, 'Desk', ['start', 'input'], deskDir)
  await rememberCredential(deskDir, secrets)
  await page.getByTestId('enrollment-dismiss').click()
  await expect(page.locator('body')).not.toContainText(deskToken)
  await expectNoStoredSecrets(page, secrets)
  const deskPid = startBatond(state, deskDir)
  await trackPid(deskPid)
  const desk = page.locator('[data-display-name="Desk"]')
  await expect(desk).toBeVisible()
  await expect(desk.getByTestId('node-presence')).toHaveText('在线')
  await expect(desk.getByTestId('node-sync')).toHaveText('已同步')
  await expect(desk.getByTestId('node-executable')).toHaveText('可执行')
  await expect(desk.getByTestId('node-capabilities')).toContainText('start')
  await expect(desk.getByTestId('node-capabilities')).toContainText('input')
  await expect(desk.getByTestId('node-last-contact')).not.toContainText('尚未报告')
  const deskId = await desk.getAttribute('data-node-id')
  expect(deskId).toBeTruthy()

  const laptopDir = `${state.workDir}/laptop`
  const laptopToken = await issueToken(page, secrets)
  await registerNode(state, laptopToken, 'Laptop', ['start'], laptopDir)
  await rememberCredential(laptopDir, secrets)
  await page.getByTestId('enrollment-dismiss').click()
  await expect(page.locator('body')).not.toContainText(laptopToken)
  await expectNoStoredSecrets(page, secrets)
  const laptop = page.locator('[data-display-name="Laptop"]')
  await expect(laptop).toBeVisible()
  await expect(laptop.getByTestId('node-presence')).toHaveText('离线')
  await expect(laptop.getByTestId('node-sync')).toHaveText('尚未同步')
  await expect(laptop.getByTestId('node-last-contact')).toContainText('尚未报告')
  await expect(laptop.getByTestId('node-executable')).toHaveText('不可执行')
  const laptopId = await laptop.getAttribute('data-node-id')
  expect(laptopId).toBeTruthy()

  const notes = `${deskDir}/notes`
  const outside = `${deskDir}/outside`
  await mkdir(notes, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(`${notes}/hello.txt`, 'hello from node\n', { mode: 0o600 })
  await writeFile(`${notes}/big.txt`, 'A'.repeat(70 * 1024), { mode: 0o600 })
  await writeFile(`${outside}/secret.txt`, 'OUTSIDE_SENTINEL', { mode: 0o600 })
  await symlink(`${outside}/secret.txt`, `${notes}/escape.txt`)
  await new Promise<void>((resolve, reject) => {
    execFile(state.batondBin, ['files', 'add', '--id', 'notes', '--path', notes, '--data-dir', deskDir], { env: childEnv({}) }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })
  await desk.getByTestId('browse-open').click()
  await expect(desk.getByTestId('browse-root-notes')).toBeVisible()
  await desk.getByTestId('browse-root-notes').click()
  await desk.getByTestId('browse-entry-hello.txt').click()
  await expect(desk.getByTestId('browse-preview')).toContainText('hello from node')
  await expect(desk.getByTestId('browse-truncated')).toHaveCount(0)
  await expect(desk.locator('textarea')).toHaveCount(0)
  await desk.getByTestId('browse-entry-big.txt').click()
  await expect(desk.getByTestId('browse-truncated')).toContainText('不会继续传输')
  const preview = await desk.getByTestId('browse-preview').innerText()
  expect(preview.length).toBeLessThanOrEqual(64 * 1024)
  expect(preview.length).toBeGreaterThan(1024)
  expect(preview).not.toContain('OUTSIDE_SENTINEL')
  await desk.getByTestId('browse-entry-escape.txt').click()
  await expect(desk.getByTestId('browse-error')).toContainText('路径超出允许的目录')
  await expect(page.locator('body')).not.toContainText('OUTSIDE_SENTINEL')
  const rejected = await page.evaluate(async (id) => {
    const escaped = await fetch(`/api/v1/nodes/${id}/files?root_id=notes&path=${encodeURIComponent('../outside/secret.txt')}`, { credentials: 'same-origin' })
    const escapedBody = await escaped.json() as { code?: string; message?: string }
    const absolute = await fetch(`/api/v1/nodes/${id}/files?root_id=notes&path=${encodeURIComponent('/etc/passwd')}`, { credentials: 'same-origin' })
    const absoluteBody = await absolute.json() as { code?: string }
    const offset = await fetch(`/api/v1/nodes/${id}/files?root_id=notes&path=big.txt&offset=65536`, { credentials: 'same-origin' })
    const offsetBody = await offset.json() as { code?: string }
    const unknown = await fetch(`/api/v1/nodes/${id}/files?root_id=nope&path=hello.txt`, { credentials: 'same-origin' })
    const unknownBody = await unknown.json() as { code?: string }
    return {
      escaped: { status: escaped.status, code: escapedBody.code ?? '', message: escapedBody.message ?? '' },
      absolute: { status: absolute.status, code: absoluteBody.code ?? '' },
      offset: { status: offset.status, code: offsetBody.code ?? '' },
      unknown: { status: unknown.status, code: unknownBody.code ?? '' },
    }
  }, deskId)
  expect(rejected.escaped).toMatchObject({ status: 403, code: 'path_escaped' })
  expect(rejected.escaped.message).not.toContain('OUTSIDE_SENTINEL')
  expect(rejected.absolute).toMatchObject({ status: 403, code: 'path_escaped' })
  expect(rejected.offset.status).toBe(400)
  expect(rejected.unknown).toMatchObject({ status: 403, code: 'root_forbidden' })
  await expect(laptop.getByTestId('browse-open')).toBeDisabled()
  const offline = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/nodes/${id}/files`, { credentials: 'same-origin' })
    const body = await response.json() as { code?: string }
    return { status: response.status, code: body.code ?? '' }
  }, laptopId)
  expect(offline).toEqual({ status: 409, code: 'node_offline' })

  await page.getByTestId('default-pc-select').selectOption(laptopId ?? '')
  await expect(page.getByTestId('default-pc-offline')).toBeVisible()
  await page.getByTestId('default-pc-save').click()
  await expect(page.getByTestId('default-pc-saved')).toContainText('Laptop')
  await expect(page.getByTestId('default-pc-saved')).toContainText(laptopId ?? '')
  await expect(page.getByTestId('default-pc-current')).toContainText(laptopId ?? '')

  await stopPid(state.relayPid)
  await waitForPortClosed(state.nodePort)
  await laptop.getByTestId('revoke-open').click()
  await laptop.getByTestId('revoke-confirm').click()
  const revokeStatus = laptop.getByTestId('revoke-status')
  await expect(revokeStatus).toHaveAttribute('data-status', 'pending')
  await expect(revokeStatus).toContainText('处理中')
  await expect(revokeStatus).toContainText('尚未生效')
  await expect(revokeStatus).toContainText('不会停止')
  await expect(revokeStatus).not.toContainText('已生效')
  await expect(page.getByTestId('default-pc-invalid')).toContainText('重新选择')
  await expect(page.getByTestId('default-pc-current')).toContainText(laptopId ?? '')
  await expect(page.getByTestId('default-pc-current')).not.toContainText(deskId ?? '')
  await expect(page.getByTestId('default-pc-select')).toHaveValue('')

  const restored = await restartRelay(state)
  await expect(revokeStatus).toHaveAttribute('data-status', 'effective')
  await expect(revokeStatus).toContainText('已生效')
  await expect(revokeStatus).toContainText('不会停止')
  await expect(page.getByTestId('default-pc-invalid')).toBeVisible()
  await expect(page.getByTestId('default-pc-current')).toContainText(laptopId ?? '')
  await expect(page.getByTestId('default-pc-select')).toHaveValue('')

  const csrfRejected = await page.evaluate(async () => {
    const response = await fetch('/api/v1/node-enrollments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await response.json() as { code?: string }
    return { status: response.status, code: body.code ?? '' }
  })
  expect(csrfRejected).toEqual({ status: 403, code: 'csrf_rejected' })
  await expect(page.getByTestId('node-list')).toContainText('Desk')

  const crossOrigin = await apiRequest.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Origin: 'https://evil.example' },
  })
  const originResponse = await crossOrigin.post(`${restored.baseURL}/api/v1/login`, {
    data: { username: 'alice', password: 'not-a-valid-password' },
  })
  expect(originResponse.status()).toBe(403)
  expect(await originResponse.json()).toMatchObject({ code: 'origin_rejected' })
  await crossOrigin.dispose()

  const bobContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const bobPage = await bobContext.newPage()
  await bobPage.goto(`${restored.baseURL}/`)
  await changeInitialPassword(bobPage, state.bob.username, state.bob.password, bobNext)
  await login(bobPage, state.bob.username, bobNext)
  await expect(bobPage.getByTestId('node-list')).not.toContainText('Desk')
  await expect(bobPage.getByTestId('node-list')).not.toContainText('Laptop')
  const forbidden = await bobPage.evaluate(async (id) => {
    const response = await fetch(`/api/v1/nodes/${id}`, { credentials: 'same-origin' })
    return { status: response.status, body: await response.text() }
  }, deskId)
  expect(forbidden.status).toBe(403)
  expect(forbidden.body).not.toContain('Desk')
  expect(forbidden.body).not.toContain('Alice')
  await bobContext.close()

  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-form')).toContainText('已退出')
  await page.context().addCookies([{
    name: 'baton_session',
    value: 'invalid-session-token-value',
    url: restored.baseURL,
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  }])
  await page.goto(`${restored.baseURL}/`)
  await expect(page.getByTestId('login-form')).toBeVisible()
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me', { credentials: 'same-origin' })
    const body = await response.json() as { code?: string }
    return { status: response.status, code: body.code ?? '' }
  })
  expect(me).toEqual({ status: 401, code: 'unauthenticated' })

  const leaked = consoleText.filter((line) => secrets.some((secret) => secret.length >= 8 && line.includes(secret)))
  expect(leaked).toEqual([])
  await assertLogsClean(restored, secrets)
})

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.getByTestId('login-username').fill(username)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
}

async function changeInitialPassword(page: Page, username: string, current: string, next: string): Promise<void> {
  await login(page, username, current)
  await expect(page.getByTestId('password-form')).toBeVisible()
  await expect(page.getByTestId('node-list')).toHaveCount(0)
  await page.getByTestId('password-current').fill(current)
  await page.getByTestId('password-new').fill(next)
  await page.getByTestId('password-confirm').fill(next)
  await page.getByTestId('password-submit').click()
  await expect(page.getByTestId('login-form')).toContainText('请用新口令重新登录')
}

async function issueToken(page: Page, secrets: string[]): Promise<string> {
  await page.getByTestId('enrollment-issue').click()
  const token = await page.getByTestId('enrollment-token').inputValue()
  expect(token.length).toBeGreaterThan(20)
  secrets.push(token)
  const usage = await page.getByTestId('register-usage').innerText()
  expect(usage).toContain('batond register')
  expect(usage).toContain('BATON_ENROLLMENT_TOKEN')
  expect(usage).not.toContain(token)
  await expectNoStoredSecrets(page, [token])
  return token
}

async function rememberCredential(dir: string, secrets: string[]): Promise<void> {
  const raw = await readFile(`${dir}/identity.json`, 'utf8')
  const parsed = JSON.parse(raw) as { credential?: { token?: string } }
  const token = parsed.credential?.token ?? ''
  if (token.length < 20) throw new Error('节点身份里没有连接凭据')
  secrets.push(token)
}

async function expectNoStoredSecrets(page: Page, secrets: string[]): Promise<void> {
  const dump = await page.evaluate(() => ({
    local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
    session: Object.entries(sessionStorage)
      .filter(([key]) => key !== 'baton_csrf')
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    csrf: sessionStorage.getItem('baton_csrf') ?? '',
    href: location.href,
  }))
  for (const secret of secrets) {
    if (secret.length < 8 || secret === dump.csrf) continue
    if (dump.local.includes(secret) || dump.href.includes(secret) || dump.session.includes(secret) || dump.csrf.includes(secret)) {
      throw new Error('页面把凭据放进了 localStorage、sessionStorage 或 URL')
    }
  }
}
