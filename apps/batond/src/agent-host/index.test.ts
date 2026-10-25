import { expect, it, vi } from 'vite-plus/test'

const loaded = vi.hoisted(() => new Set<string>())
vi.mock('../agents/cursor/host-module.ts', () => {
  loaded.add('cursor')
  throw new Error('Cursor SDK is unavailable')
})
vi.mock('../agents/pi/host-module.ts', () => {
  loaded.add('pi')
  return { piAgentHostModule: { driver: vi.fn() } }
})

it('loads a non-Cursor host without importing the Cursor host module', async () => {
  const { agentHostModule, agentHostModuleNames } = await import('./index.ts')
  expect(agentHostModuleNames()).toEqual(['cursor', 'pi', 'codex', 'kiro'])
  expect(loaded).toEqual(new Set())
  expect(await agentHostModule('pi')).toBeDefined()
  expect(loaded).toEqual(new Set(['pi']))
  expect(await agentHostModule('unknown')).toBeUndefined()
})
