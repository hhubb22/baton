import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'
import { diagnosticSummary, readLogTail, redactDiagnostics, type DesktopDiagnostics } from './diagnostics.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function logFile() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'baton-diagnostics-'))
  directories.push(directory)
  return join(directory, 'desktop-batond.log')
}

it.each([
  'BATON_ENROLLMENT_TOKEN=offline-enrollment-value',
  'register --code offline-registration-value',
  'setup code: offline-setup-value',
  'Authorization: Bearer offline-authorization-value',
  'authorization: Basic offline-basic-value',
  'Cookie: session=offline-cookie-value',
  'Set-Cookie: session=offline-response-cookie-value',
  'OPENAI_API_KEY=offline-model-value',
  'ANTHROPIC_AUTH_TOKEN=offline-provider-value',
  '{"request":{"credentials":{"value":"offline-nested-value"}}}',
  'deployment.json: {"coordinator_url":"https://private-center.test","ca_pem":"offline-ca-value"}',
  'INFO using apiKey offline-inline-value',
  'INFO request sk-offline-example-value',
  'INFO request eyJoffline.offline.signature',
])('隐藏凭据或配置行：%s', (line) => {
  expect(redactDiagnostics(`${line}\nINFO daemon online`)).toBe('[REDACTED]\nINFO daemon online')
})

it('隐藏完整嵌套 JSON、数组和多行值，包含无字段名的私有内容', () => {
  const result = redactDiagnostics(
    [
      'INFO daemon starting',
      'DEBUG request {',
      '  "registration": {',
      '    "code":',
      '      "offline-registration-value",',
      '    "models": [',
      '      {"headers": {"X-Custom": "offline-model-value"}}',
      '    ]',
      '  }',
      '}',
      'INFO daemon connecting',
      'apiKey:',
      'offline-pretty-value',
      'more-private-content',
      '',
      'INFO daemon online',
    ].join('\n'),
  )
  expect(result).toContain('INFO daemon starting')
  expect(result).toContain('INFO daemon connecting')
  expect(result).toContain('INFO daemon online')
  expect(result).not.toMatch(/offline-|private-content|X-Custom|models|registration/)
})

it('部署私有内容和截断的配置按整段隐藏', () => {
  for (const block of [
    'deployment:\noffline-private-center\noffline-private-ca',
    'config =\n{\n"arbitrary": "offline-private-value"\n}',
    '  "arbitrary":\n"offline-fragment-value"\n}',
    'api_key = "\noffline-unclosed-value\nmore-private-content',
  ]) {
    const result = redactDiagnostics(`${block}\nINFO recovered`)
    expect(result).not.toMatch(/offline-|private-content|arbitrary/)
    expect(result).toContain('INFO recovered')
  }
})

it('隐藏 PEM 私钥全部内容，未闭合的私钥一直隐藏到末尾', () => {
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']) {
    const result = redactDiagnostics(
      `INFO before\n-----BEGIN ${kind}PRIVATE KEY-----\noffline-body-one\noffline-body-two\n-----END ${kind}PRIVATE KEY-----\nINFO after`,
    )
    expect(result).not.toMatch(/PRIVATE KEY|offline-body/)
    expect(result).toContain('INFO before')
    expect(result).toContain('INFO after')
  }
  expect(redactDiagnostics('-----BEGIN PRIVATE KEY-----\noffline-body\nINFO still private')).toBe(
    '[REDACTED]\n[REDACTED]\n[REDACTED]',
  )
})

it('URL 移除用户信息和所有查询、片段，包括编码和未知名称的凭据', () => {
  const result = redactDiagnostics(
    [
      'INFO fetch https://offline-user:offline-password@center.test/status?api%5Fkey=offline-query&unknown=offline-other#offline-fragment',
      'INFO connect baton://connect?url=offline-deployment&ca=offline-ca',
      'INFO fetch https://center.test/status?x=offline-value',
    ].join('\n'),
  )
  expect(result).not.toMatch(/offline-|api%5Fkey|unknown=/)
  expect(result).toContain('https://center.test/status?redacted#redacted')
  expect(result).toContain('baton://connect?redacted')
})

it('移除终端颜色控制后识别凭据，普通日志保持可读', () => {
  expect(redactDiagnostics('INFO daemon online\r\nWARN reconnecting')).toBe('INFO daemon online\nWARN reconnecting')
  expect(redactDiagnostics('API_\u001b[31mKEY=offline-colored-value')).toBe('[REDACTED]')
  expect(redactDiagnostics('2026-06-01T12:00:00Z INFO connected')).toBe('2026-06-01T12:00:00Z INFO connected')
})

const info: DesktopDiagnostics = {
  clientVersion: '1.2.3',
  batondVersion: '1.2.4',
  platform: 'darwin-arm64',
  processState: 'restarting',
  lastExit: { at: '2026-06-01T12:00:00.000Z', reason: 'batond exited (code: 7, signal: none)' },
  upgradePhase: 'draining',
  canRestart: false,
}

it('摘要包含版本、平台、设备状态、最近退出、升级阶段和最后 200 行日志', () => {
  const result = diagnosticSummary(info, Array.from({ length: 250 }, (_, i) => `log line ${i}`).join('\n') + '\n')
  for (const value of ['1.2.3', '1.2.4', 'darwin-arm64', 'restarting', info.lastExit!.at, 'code: 7', 'draining']) {
    expect(result).toContain(value)
  }
  expect(result).toContain('可以重启： 否')
  const log = result.split('最近 batond 日志（最多 200 行）：\n')[1]!
  expect(log.split('\n')).toHaveLength(200)
  expect(log.split('\n')[0]).toBe('log line 50')
  expect(log.split('\n').at(-1)).toBe('log line 249')
})

it('摘要脱敏所有可变字段和退出消息，并在截取日志前处理多行私有内容', () => {
  const result = diagnosticSummary(
    {
      clientVersion: 'api_key=offline-version-value',
      batondVersion: 'token=offline-batond-value',
      platform: 'deployment=offline-platform-value',
      processState: 'Cookie: offline-state-value',
      lastExit: { at: 'secret=offline-date-value', reason: 'failed\nAuthorization: offline-reason-value' },
      upgradePhase: 'password=offline-phase-value',
      canRestart: true,
    },
    'deployment:\n' + Array.from({ length: 250 }, (_, i) => `offline-private-content-${i}`).join('\n'),
  )
  expect(result).not.toContain('offline-')
  expect(result).toContain('可以重启： 是')
  expect(result.split('最近 batond 日志（最多 200 行）：\n')[1]!.split('\n')).toHaveLength(200)
})

it('无最近退出、升级或日志时仍可生成摘要', () => {
  const result = diagnosticSummary({ ...info, lastExit: null, upgradePhase: null }, '')
  expect(result).toContain('最近退出： 无')
  expect(result).toContain('升级阶段： 无')
  expect(result).toContain('（日志不可用）')
})

it('日志不存在或为空时返回空字符串，不读取轮转文件', async () => {
  const path = await logFile()
  await fs.writeFile(path + '.1', 'offline-rotated-value')
  expect(await readLogTail(path)).toBe('')
  await fs.writeFile(path, '')
  expect(await readLogTail(path)).toBe('')
})

it.each(['\n', '\r\n'])('尾读保留最终 200 行与 UTF-8，处理换行 %j', async (newline) => {
  const path = await logFile()
  const lines = Array.from({ length: 5000 }, (_, i) => `INFO 日志 ${i}: ${'设备'.repeat(30)}`)
  for (const ending of ['', newline]) {
    await fs.writeFile(path, lines.join(newline) + ending)
    expect(await readLogTail(path)).toBe(lines.slice(-200).join('\n'))
  }
})

it.each([201, 30_000])('实际尾读与摘要复制链路隐藏跨越 200 行边界的 %i 行私有值', async (length) => {
  const path = await logFile()
  await fs.writeFile(
    path,
    'API_KEY="\n' + Array.from({ length }, (_, i) => `offline-part-${i}`).join('\n') + '\n"\nINFO daemon exited\n',
  )
  const summary = diagnosticSummary(info, await readLogTail(path))
  expect(summary).not.toContain('offline-part-')
  const log = summary.split('最近 batond 日志（最多 200 行）：\n')[1]!
  expect(log.split('\n')).toHaveLength(200)
  expect(log).toContain('[REDACTED]')
  expect(log.split('\n').at(-1)).toBe('INFO daemon exited')
})

it('尾读截断处没有明确日志边界时隐藏全部未知内容', async () => {
  const path = await logFile()
  await fs.writeFile(path, Array.from({ length: 30_000 }, (_, i) => `offline-part-${i}`).join('\n'))
  const summary = diagnosticSummary(info, await readLogTail(path))
  expect(summary).not.toContain('offline-part-')
  expect(summary).toContain('[REDACTED]')
})

it('短日志不丢首行或末行', async () => {
  const path = await logFile()
  await fs.writeFile(path, 'first\n\nlast')
  expect(await readLogTail(path)).toBe('first\n\nlast')
})

it('10MB 日志丢弃超出尾读上限的残行', async () => {
  const path = await logFile()
  const handle = await fs.open(path, 'w+')
  await handle.truncate(10 * 1024 * 1024)
  const suffix = '\nINFO final record\n'
  await handle.write(suffix, 10 * 1024 * 1024 - Buffer.byteLength(suffix), 'utf8')
  await handle.close()
  expect(await readLogTail(path)).toBe('INFO final record')
})

it('只含超长残行时返回空字符串；真实读取错误保留给调用方', async () => {
  const path = await logFile()
  await fs.writeFile(path, 'x'.repeat(300 * 1024))
  expect(await readLogTail(path)).toBe('')
  const directory = path + '.directory'
  await fs.mkdir(directory)
  await expect(readLogTail(directory)).rejects.toThrow()
})
