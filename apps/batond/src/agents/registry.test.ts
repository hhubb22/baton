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

it('keeps Kiro discovery unverified when upstream cannot confirm its account or version', () => {
  const report = hostedAgentReport(
    'kiro',
    {
      authenticated: 'unknown',
      models: ['qwen3-coder-next'],
      reason: 'Kiro 上游只读探测尚不能确认认证与版本',
      details: { installed: true, version: 'unknown', platform: 'darwin-arm64' },
    },
    'Kiro CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({
    status: 'unverified',
    reason: 'Kiro 上游只读探测尚不能确认认证与版本',
    capabilities: { create: false, steer: false, resume: false, switch_model: false },
  })
})

it('exposes only Kiro queue, stop and restore when its account and combination are verified', () => {
  const report = hostedAgentReport(
    'kiro',
    {
      authenticated: 'valid',
      models: ['qwen3-coder-next'],
      details: { installed: true, version: '2.32.0', platform: 'darwin-arm64' },
    },
    'Kiro CLI 未安装或尚未认证',
  )
  expect(report).toMatchObject({
    status: 'available',
    capabilities: { create: true, queue: true, stop: true, resume: true, steer: false, switch_model: false },
  })
})
