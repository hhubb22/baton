import { expect, it } from 'vite-plus/test'
import { hostedAgentReport } from './registry.ts'

it('keeps an authenticated Pi unavailable until its platform is in the verified set', () => {
  const verified = hostedAgentReport(
    'pi',
    {
      authenticated: 'valid',
      models: ['openrouter/example'],
      details: { version: '1.0.0', platform: 'darwin-arm64', installed: true },
    },
    'missing',
  )
  expect(verified.status).toBe('available')
  expect(verified.capabilities).toMatchObject({ create: true, steer: true, resume: true, switch_model: false })

  const other = hostedAgentReport(
    'pi',
    {
      authenticated: 'valid',
      models: ['openrouter/example'],
      details: { version: '1.0.0', platform: 'linux-x64', installed: true },
    },
    'missing',
  )
  expect(other.status).toBe('unverified')
  expect(other.capabilities.create).toBe(false)
})

it('reports a missing Pi install as unavailable', () => {
  const report = hostedAgentReport(
    'codex',
    {
      authenticated: 'missing',
      models: [],
      reason: 'Codex CLI is not authenticated',
      details: { installed: false, version: 'unknown', platform: 'darwin-arm64' },
    },
    'Codex CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({ status: 'unavailable', reason: 'Codex CLI is not authenticated' })
})

it('keeps Kiro unverified when its executable version cannot be confirmed', () => {
  const report = hostedAgentReport(
    'kiro',
    {
      authenticated: 'unknown',
      models: ['qwen3-coder-next'],
      reason: 'Kiro 版本暂不可确认',
      details: { installed: true, version: 'unknown', platform: 'darwin-arm64' },
    },
    'Kiro CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({
    status: 'unverified',
    reason: 'Kiro 版本暂不可确认',
    capabilities: { create: false, steer: false, resume: false, switch_model: false },
  })
})

it('allows the recorded Kiro combination with unknown authentication and a native default model', () => {
  const report = hostedAgentReport(
    'kiro',
    {
      authenticated: 'unknown',
      models: [],
      details: { installed: true, version: '2.32.0', platform: 'darwin-arm64' },
    },
    'Kiro CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({
    status: 'available',
    default_model: 'default',
    reason: 'Kiro 认证状态未知，首次执行时由原生程序检查',
    capabilities: { create: true, queue: true, stop: true, resume: true, steer: false, switch_model: false },
  })
})

it.each([
  { version: '2.32.0', platform: 'linux-x64' },
  { version: '2.33.0', platform: 'darwin-arm64' },
  { version: '2.32.0-preview.1', platform: 'darwin-arm64' },
])('keeps Kiro $version / $platform unverified', ({ version, platform }) => {
  const report = hostedAgentReport(
    'kiro',
    { authenticated: 'unknown', models: [], details: { installed: true, version, platform } },
    'missing',
  )
  expect(report).toMatchObject({ status: 'unverified', capabilities: { create: false, resume: false } })
})

it('rejects Kiro when upstream confirms that authentication is missing', () => {
  const report = hostedAgentReport(
    'kiro',
    {
      authenticated: 'missing',
      models: [],
      details: { installed: true, version: '2.32.0', platform: 'darwin-arm64' },
    },
    'Kiro CLI 尚未认证',
  )
  expect(report).toMatchObject({ status: 'unavailable', capabilities: { create: false, resume: false } })
})

it.each(['pi', 'codex'] satisfies Array<'pi' | 'codex'>)('%s still requires confirmed authentication', (agentType) => {
  const report = hostedAgentReport(
    agentType,
    {
      authenticated: 'unknown',
      models: [],
      details: { installed: true, version: agentType === 'pi' ? '1.0.0' : '0.156.1', platform: 'darwin-arm64' },
    },
    'missing',
  )
  expect(report).toMatchObject({ status: 'unverified', capabilities: { create: false, resume: false } })
})
