import { Effect } from 'effect'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { runDaemonCLI } from './cli.ts'
import { runDaemon } from './daemon.ts'
import { loadIdentity } from './identity.ts'
import { initializeBrowseRoots } from './roots.ts'

vi.mock('./daemon.ts', () => ({ runDaemon: vi.fn(() => Effect.void) }))
vi.mock('./identity.ts', () => ({
  defaultDataDirectory: () => '/offline-node',
  isMissing: () => false,
  loadIdentity: vi.fn(),
  registerNode: vi.fn(),
}))
vi.mock('./roots.ts', () => ({ initializeBrowseRoots: vi.fn() }))

const identity: NodeIdentity = {
  node_id: '729f92e9-e68c-4a30-817a-0adb2da87b51',
  employee_id: '74b66275-348c-4dd3-ae1d-7f3d21440f70',
  display_name: 'Offline node',
  system: 'linux',
  role: '',
  capabilities: [],
  registration_seq: 1,
  registered_at: '2026-10-23T02:00:00Z',
  credential: {
    id: 'c6559d72-c581-4f4d-bef0-3f80724d1856',
    token: 'offline-test-token',
    version: 1,
    expires_at: '2099-01-01T00:00:00Z',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadIdentity).mockResolvedValue(identity)
})

it.each(['up', 'run'])('passes the default control budget through %s', async (action) => {
  if (action !== 'up' && action !== 'run') throw new Error('Invalid fixture action')
  await runDaemonCLI(action, [])
  expect(runDaemon).toHaveBeenCalledWith(expect.objectContaining({ controlTimeoutSeconds: 370 }))
})

it.each(['1', '3600'])('passes an explicit %s-second control budget to the daemon', async (value) => {
  await runDaemonCLI('run', ['--control-timeout-seconds', value])
  expect(runDaemon).toHaveBeenCalledWith(expect.objectContaining({ controlTimeoutSeconds: Number(value) }))
})

it.each(['0', '-1', '1.5', '3601', 'NaN', 'Infinity'])(
  'rejects invalid control budget %s before touching device state',
  async (value) => {
    await expect(runDaemonCLI('run', [`--control-timeout-seconds=${value}`])).rejects.toThrow(
      '--control-timeout-seconds',
    )
    expect(initializeBrowseRoots).not.toHaveBeenCalled()
    expect(loadIdentity).not.toHaveBeenCalled()
    expect(runDaemon).not.toHaveBeenCalled()
  },
)
