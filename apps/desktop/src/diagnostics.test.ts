import { expect, it } from 'vite-plus/test'
import { diagnosticSummary, redactDiagnostics, type DesktopDiagnostics } from './diagnostics.ts'

it.each([
  'BATON_PRIVATE_VALUE=offline-private-value',
  'register --code offline-registration-value',
  'setup code: offline-setup-value',
  'Authorization: Bearer offline-authorization-value',
  'authorization: Basic offline-basic-value',
  'Cookie: session=offline-cookie-value',
  'Set-Cookie: session=offline-response-cookie-value',
  'OPENAI_API_KEY=offline-model-value',
  'ANTHROPIC_AUTH_TOKEN=offline-provider-value',
  '{"request":{"credentials":{"value":"offline-nested-value"}}}',
  'coordinator.json: {"coordinator_url":"https://private-center.test","ca_pem":"offline-ca-value"}',
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
      'INFO connect baton://connect?url=offline-coordinator&ca=offline-ca',
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
  deviceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  lastExit: { at: '2026-06-01T12:00:00.000Z', reason: 'batond exited (code: 7, signal: none)', code: 'daemon_failed' },
  canRestart: false,
}

it('copies only time, versions, device and error code', () => {
  const result = diagnosticSummary(info)
  const lines = result.split('\n')
  expect(lines).toHaveLength(5)
  expect(result).toContain('客户端版本： 1.2.3')
  expect(result).toContain('服务端版本： 1.2.4')
  expect(result).toContain('设备 ID： aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  expect(result).toContain('错误码： daemon_failed')
  expect(result).toMatch(/^时间： \d{4}-\d{2}-\d{2}T/)
  expect(result).not.toContain('batond exited')
  expect(result).not.toContain('darwin-arm64')
  expect(result).not.toContain('restarting')
})
