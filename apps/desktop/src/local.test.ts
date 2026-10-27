import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { authorizeBridge } from './bridge.ts'
import { desktopCapabilities } from './capabilities.ts'
import { LocalActions, localAccount, registerLocalBridge, type LocalDependencies } from './local.ts'

const node = '11111111-1111-4111-8111-111111111111'
const employee = '22222222-2222-4222-8222-222222222222'
const thread = '33333333-3333-4333-8333-333333333333'
const other = '44444444-4444-4444-8444-444444444444'
const identity = { node_id: node, employee_id: employee, coordinator_url: 'https://center.test' }
const info = {
  clientVersion: '1',
  batondVersion: '1',
  platform: 'darwin arm64',
  processState: 'online',
  lastExit: null,
  upgradePhase: null,
  canRestart: true,
}
function fixture(path = '/missing-folder') {
  const dependencies: LocalDependencies = {
    identity: vi.fn(async () => identity),
    threadNode: vi.fn(async () => node),
    directory: vi.fn(async () => ({ ...identity, working_directory: path })),
    openDirectory: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => null),
    diagnostics: vi.fn(async () => info),
    restart: vi.fn(async () => {}),
    openLogs: vi.fn(async () => {}),
    copyDiagnostics: vi.fn(async () => {}),
  }
  return { dependencies, actions: new LocalActions(dependencies) }
}

it('requires the authenticated center employee to own the local identity', () => {
  const saved = { ...identity, registered: true as const, display_name: 'Local', system: 'macos' }
  expect(localAccount(saved, identity.coordinator_url, employee)).toEqual(identity)
  expect(() => localAccount(saved, identity.coordinator_url, other)).toThrow('Sign in')
  expect(() => localAccount(saved, 'https://other.test', employee)).toThrow('Sign in')
  expect(() => localAccount({ registered: false }, identity.coordinator_url, employee)).toThrow('Connect')
})

it('declares all three versioned local capabilities', () => {
  for (const name of ['open-local', 'pick-directory', 'diagnostics'])
    expect(desktopCapabilities).toContainEqual({ name, version: 1 })
})

it('every local IPC rejects foreign windows, subframes and setup pages before performing any action', async () => {
  const { actions, dependencies } = fixture()
  const handlers = new Map<string, (event: { url: string; main: boolean }, input: unknown) => Promise<unknown>>()
  registerLocalBridge<{ url: string; main: boolean }>(
    (channel, callback) => handlers.set(channel, callback),
    (event) => authorizeBridge(event.url, identity.coordinator_url, event.main),
    actions,
  )
  expect(handlers.size).toBe(6)
  for (const handler of handlers.values())
    for (const event of [
      { url: 'https://elsewhere.test', main: true },
      { url: 'file:///setup.html', main: true },
      { url: 'https://center.test', main: false },
    ])
      await expect(handler(event, { nodeId: node })).rejects.toThrow('只有中心主页面')
  expect(dependencies.identity).not.toHaveBeenCalled()
  expect(dependencies.openDirectory).not.toHaveBeenCalled()
})

it('opens only a locally recorded work directory for an authenticated local Thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-local-'))
  try {
    const { actions, dependencies } = fixture(await realpath(directory))
    await actions.openLocal({ threadId: thread, action: 'reveal' })
    await actions.openLocal({ threadId: thread, action: 'editor' })
    expect(dependencies.directory).toHaveBeenCalledWith(thread)
    expect(dependencies.openDirectory).toHaveBeenCalledWith(await realpath(directory), false)
    expect(dependencies.openDirectory).toHaveBeenCalledWith(await realpath(directory), true)
    await expect(actions.openLocal({ threadId: thread, action: 'editor', path: '/etc' })).rejects.toThrow('Invalid')
    vi.mocked(dependencies.threadNode).mockResolvedValue(other)
    await expect(actions.openLocal({ threadId: thread, action: 'reveal' })).rejects.toThrow('not on this computer')
    vi.mocked(dependencies.threadNode).mockResolvedValue(node)
    for (const mismatch of [{ node_id: other }, { employee_id: other }, { coordinator_url: 'https://other.test' }]) {
      vi.mocked(dependencies.directory).mockResolvedValue({ ...identity, working_directory: directory, ...mismatch })
      await expect(actions.openLocal({ threadId: thread, action: 'reveal' })).rejects.toThrow('not on this computer')
    }
    expect(dependencies.openDirectory).toHaveBeenCalledTimes(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not create missing folders and rejects links that replace the validated directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-missing-'))
  try {
    const { actions, dependencies } = fixture(join(directory, 'missing'))
    await expect(actions.openLocal({ threadId: thread, action: 'reveal' })).rejects.toThrow('no longer exists')
    const link = join(directory, 'link')
    await symlink(tmpdir(), link)
    vi.mocked(dependencies.directory).mockResolvedValue({ ...identity, working_directory: link })
    await expect(actions.openLocal({ threadId: thread, action: 'reveal' })).rejects.toThrow('folder changed')
    vi.mocked(dependencies.directory).mockRejectedValue(new Error('Not a work directory'))
    await expect(actions.openLocal({ threadId: thread, action: 'reveal' })).rejects.toThrow('Not a work directory')
    expect(dependencies.openDirectory).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('cancelling native selection returns null and foreign device actions are denied', async () => {
  const { actions, dependencies } = fixture()
  await expect(actions.pickDirectory({ nodeId: node })).resolves.toBeNull()
  for (const method of ['pickDirectory', 'diagnostics', 'restartDaemon', 'openLogs', 'copyDiagnostics'] as const)
    await expect(actions[method]({ nodeId: other })).rejects.toThrow('not this computer')
  expect(dependencies.pickDirectory).toHaveBeenCalledTimes(1)
  expect(dependencies.restart).not.toHaveBeenCalled()
})

it('never restarts an external service or during migration', async () => {
  const { actions, dependencies } = fixture()
  for (const state of ['external', 'stopped']) {
    vi.mocked(dependencies.diagnostics).mockResolvedValue({ ...info, processState: state, canRestart: false })
    await expect(actions.restartDaemon({ nodeId: node })).rejects.toThrow('cannot be restarted')
  }
  expect(dependencies.restart).not.toHaveBeenCalled()
})
