import { releaseMetadata } from '@baton/protocol/release'
import { Effect } from 'effect'
import { beforeEach, expect, it, vi } from 'vite-plus/test'

const { loaded, run } = vi.hoisted(() => ({ loaded: new Set<string>(), run: vi.fn() }))
vi.mock('../agent-host/host.ts', () => ({ runAgentHost: run }))
vi.mock('../agents/cursor/host-module.ts', () => {
  loaded.add('cursor')
  return { cursorAgentHostModule: { driver: vi.fn() } }
})
vi.mock('../agents/pi/host-module.ts', () => {
  loaded.add('pi')
  return { piAgentHostModule: { driver: vi.fn() } }
})
vi.mock('../agents/codex/host-module.ts', () => {
  loaded.add('codex')
  return { codexAgentHostModule: { driver: vi.fn() } }
})
vi.mock('../agents/kiro/host-module.ts', () => {
  loaded.add('kiro')
  return { kiroAgentHostModule: { driver: vi.fn() } }
})
vi.mock('../agents/antigravity/host-module.ts', () => {
  loaded.add('antigravity')
  return { antigravityAgentHostModule: { driver: vi.fn() } }
})
vi.mock('../agents/droid/host-module.ts', () => {
  loaded.add('droid')
  return { droidAgentHostModule: { driver: vi.fn() } }
})

beforeEach(() => {
  vi.resetModules()
  loaded.clear()
  run.mockReset().mockReturnValue(Effect.void)
})

it('rejects unknown types before loading, isolates selected hosts and inspects every hosted entry', async () => {
  const { runAgentHostCommand } = await import('./agent-host.ts')
  const paths = { workingDirectory: '/workspace', privateDirectory: '/private' }
  await expect(Effect.runPromise(Effect.scoped(runAgentHostCommand('unknown', paths)))).rejects.toThrow(
    'Unknown Agent host type',
  )
  expect(loaded.size).toBe(0)
  await Effect.runPromise(Effect.scoped(runAgentHostCommand('pi', paths)))
  expect(loaded).toEqual(new Set(['pi']))
  expect(run).toHaveBeenCalledWith(expect.any(Object), { agentType: 'pi', paths })

  const { agentCatalog } = await import('../agents/catalog.ts')
  const { inspectAgentHostModules } = await import('./agent-host.ts')
  const agents = Object.entries(agentCatalog)
    .filter(([, agent]) => agent.kind === 'hosted')
    .map(([type]) => type)
  expect(await inspectAgentHostModules()).toEqual({ agents, nativeModules: [], release: releaseMetadata() })
  expect(loaded).toEqual(new Set(agents))
})
