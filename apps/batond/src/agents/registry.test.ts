import { Effect, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { RuntimeAgent } from '@baton/protocol'
import type { ProbeResult } from '../agent-host/protocol.ts'
import { agentCapabilities } from './capabilities.ts'
import { probeCursor } from './cursor/probe.ts'
import { hostedAgentReport, probeLocalCursor } from './registry.ts'

vi.mock('./cursor/sdk-loader.ts', () => ({
  inspectCursorSdk: () => ({ version: '9.0.0', platformVersion: '9.0.0', missingAssets: [] }),
}))
vi.mock('./cursor/probe.ts', () => ({ probeCursor: vi.fn() }))
vi.mock('../platform/process.ts', () => ({
  startProcessWatchdog: async () => ({ close: async () => {} }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

const providers = ['cursor', 'pi', 'codex', 'kiro'] satisfies Array<'cursor' | 'pi' | 'codex' | 'kiro'>

describe.each(providers)('%s availability', (agentType) => {
  it.each([
    { version: 'unknown', platform: 'linux-x64', authenticated: 'unknown' },
    { version: '9.0.0-preview.1+build.7', platform: 'win32-arm64', authenticated: 'valid' },
    { version: '9.0.0', platform: 'darwin-x64', authenticated: 'unknown' },
  ] satisfies Array<{ version: string; platform: string; authenticated: ProbeResult['authenticated'] }>)(
    'allows $version / $platform with $authenticated authentication',
    ({ version, platform, authenticated }) => {
      const report = hostedAgentReport(
        agentType,
        { authenticated, models: ['example', 'example'], details: { installed: true, version, platform } },
        '程序未安装或尚未认证',
      )
      expect(report).toMatchObject({
        status: 'available',
        version,
        models: [{ id: 'example', name: 'example' }],
        capabilities: agentCapabilities[agentType],
      })
      expect(report.reason).toContain(`${version} / ${platform}`)
      if (authenticated === 'unknown') expect(report.reason).toContain('认证状态未知')
      expect(Schema.is(RuntimeAgent)(report)).toBe(true)
    },
  )

  it.each([
    { installed: false, authenticated: 'unknown', reason: '程序未安装' },
    { installed: true, authenticated: 'missing', reason: '尚未认证' },
  ] satisfies Array<{ installed: boolean; authenticated: ProbeResult['authenticated']; reason: string }>)(
    'rejects $reason',
    ({ installed, authenticated, reason }) => {
      const report = hostedAgentReport(
        agentType,
        { authenticated, models: [], details: { installed }, reason },
        '程序未安装或尚未认证',
      )
      expect(report).toMatchObject({
        status: 'unavailable',
        reason,
        capabilities: { create: false, resume: false },
      })
    },
  )

  it('keeps version timeouts diagnostic and supplies the native default model', () => {
    const report = hostedAgentReport(
      agentType,
      {
        authenticated: 'unknown',
        models: [],
        details: { installed: true, version: 'unknown' },
        reason: '版本探测超时',
      },
      '程序未安装或尚未认证',
    )
    expect(report.status).toBe('available')
    expect(report.default_model).not.toBe('')
    expect(report.capabilities).toMatchObject({ create: true, resume: true, switch_model: agentType !== 'kiro' })
    expect(report.reason).toContain('版本探测超时')
    expect(report.reason).toContain('模型目录暂不可读')
    if (agentType === 'kiro' || agentType === 'cursor') expect(report.reason).toContain('上游 adapter 不支持 steer')
  })

  it('keeps a failed host probe distinct from confirmed missing installation', () => {
    const report = hostedAgentReport(
      agentType,
      { authenticated: 'unknown', models: [], details: {}, reason: '只读探测失败' },
      '程序未安装或尚未认证',
    )
    expect(report).toMatchObject({ status: 'unverified', capabilities: { create: false, resume: false } })
    expect(report.reason).toContain('安装状态尚未确认')
  })
})

it.each([{ integrity: false }, { sandboxHelper: false }])(
  'rejects explicit Cursor dependency failures: %j',
  (details) => {
    const report = hostedAgentReport(
      'cursor',
      { authenticated: 'unknown', models: [], details: { installed: true, ...details }, reason: '本机依赖不可用' },
      'Cursor SDK 未安装或尚未认证',
    )
    expect(report).toMatchObject({ status: 'unavailable', reason: '本机依赖不可用', capabilities: { create: false } })
  },
)

it('allows an installed Cursor SDK when its read-only host probe times out', async () => {
  vi.stubEnv('CURSOR_API_KEY', 'offline-test-key')
  vi.mocked(probeCursor).mockReturnValue(Effect.die('offline probe timeout'))
  const report = await probeLocalCursor()
  expect(report).toMatchObject({ status: 'available', version: '9.0.0', capabilities: { create: true, resume: true } })
  expect(report.reason).toContain('只读探测失败或超时')
})

it('requires an explicit Cursor API key even when the SDK is installed', async () => {
  vi.stubEnv('CURSOR_API_KEY', '')
  expect(await probeLocalCursor()).toMatchObject({ status: 'unavailable', reason: '需要显式配置 CURSOR_API_KEY' })
  expect(probeCursor).not.toHaveBeenCalled()
})

it('uses the common availability rule for a successful Cursor host probe', async () => {
  vi.stubEnv('CURSOR_API_KEY', 'offline-test-key')
  vi.mocked(probeCursor).mockReturnValue(
    Effect.succeed({
      authenticated: 'unknown',
      models: [],
      details: { installed: true, version: 'unknown', platform: 'win32-x64', integrity: true, sandboxHelper: true },
    }),
  )
  expect(await probeLocalCursor()).toMatchObject({ status: 'available', capabilities: { create: true, resume: true } })
})
