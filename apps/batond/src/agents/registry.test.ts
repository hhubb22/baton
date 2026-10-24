import { expect, it } from 'vite-plus/test'
import { hostedAgentReport } from './registry.ts'

it('keeps an authenticated Pi unavailable until its platform is in the verified set', () => {
  const verified = hostedAgentReport(
    'pi',
    {
      authenticated: 'valid',
      models: ['openrouter/example'],
      details: { version: '0.80.5', platform: 'darwin-arm64', installed: true },
    },
    'missing',
  )
  expect(verified.status).toBe('available')
  expect(verified.capabilities).toMatchObject({ create: true, steer: false, resume: true, switch_model: false })

  const other = hostedAgentReport(
    'pi',
    {
      authenticated: 'valid',
      models: ['openrouter/example'],
      details: { version: '0.80.5', platform: 'linux-x64', installed: true },
    },
    'missing',
  )
  expect(other.status).toBe('unverified')
  expect(other.capabilities.create).toBe(false)
})

it('reports a missing Pi install as unavailable', () => {
  const report = hostedAgentReport(
    'codex',
    { authenticated: 'missing', models: [], reason: 'Codex CLI is not authenticated', details: { installed: false, version: 'unknown', platform: 'darwin-arm64' } },
    'Codex CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({ status: 'unavailable', reason: 'Codex CLI is not authenticated' })
})
