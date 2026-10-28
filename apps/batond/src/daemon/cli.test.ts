import { PassThrough } from 'node:stream'
import { Effect } from 'effect'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { runDaemonCLI } from './cli.ts'
import { runDaemon } from './daemon.ts'
import { loadIdentity, reauthNode, registerNode } from './identity.ts'
import { initializeBrowseRoots } from '../devices/roots.ts'
import { loadDeployment } from './deployment.ts'

vi.mock('./daemon.ts', () => ({ runDaemon: vi.fn(() => Effect.void) }))
vi.mock('./deployment.ts', () => ({ loadDeployment: vi.fn() }))
vi.mock('./identity.ts', () => ({
  defaultDataDirectory: () => '/offline-node',
  isMissing: (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
  loadIdentity: vi.fn(),
  registerNode: vi.fn(),
  reauthNode: vi.fn(),
}))
vi.mock('../devices/roots.ts', () => ({ initializeBrowseRoots: vi.fn() }))

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
  vi.resetAllMocks()
  vi.mocked(runDaemon).mockImplementation(() => Effect.void)
  vi.mocked(registerNode).mockResolvedValue(identity)
  vi.mocked(loadIdentity).mockResolvedValue(identity)
  vi.mocked(reauthNode).mockResolvedValue(identity)
})

it('reauthenticates without starting the daemon or changing directory authorization and prints no credentials', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runDaemonCLI('reauth', [
      '--data-dir',
      '/saved-node',
      '--enrollment-file',
      '/private/enrollment',
      '--ca-file',
      '/private/ca.pem',
      '--coordinator',
      'https://ignored.invalid',
    ])
    expect(reauthNode).toHaveBeenCalledWith({
      dataDirectory: '/saved-node',
      enrollmentFile: '/private/enrollment',
      caFile: '/private/ca.pem',
      signal: expect.any(AbortSignal),
    })
    expect(initializeBrowseRoots).not.toHaveBeenCalled()
    expect(registerNode).not.toHaveBeenCalled()
    expect(runDaemon).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        node_id: identity.node_id,
        employee_id: identity.employee_id,
        display_name: identity.display_name,
        system: identity.system,
      }),
    )
  } finally {
    output.mockRestore()
  }
})

it('rejects enrollment secrets in reauth arguments without echoing them', async () => {
  const result = await runDaemonCLI('reauth', ['--enrollment-token=offline-secret']).catch((error: unknown) => error)
  expect(String(result)).toContain('注册凭据仅支持环境变量或私有文件')
  expect(String(result)).not.toContain('offline-secret')
  expect(reauthNode).not.toHaveBeenCalled()
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

it.each(['up', 'register'] as const)('%s uses deployment defaults only for first registration', async (action) => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    vi.mocked(loadIdentity).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    vi.mocked(loadDeployment).mockResolvedValue({
      format: 1,
      coordinator_url: 'https://deployment.invalid',
      ca_pem: 'deployment-ca',
    })
    await runDaemonCLI(action, [], { installationDirectory: '/installation' })
    expect(loadDeployment).toHaveBeenCalledWith('/installation')
    expect(registerNode).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinatorURL: 'https://deployment.invalid',
        caPem: 'deployment-ca',
      }),
    )
    vi.mocked(registerNode).mockClear()
    await runDaemonCLI(action, ['--coordinator', 'https://explicit.invalid', '--ca-file', '/explicit-ca'])
    const options = vi.mocked(registerNode).mock.calls[0]![0]
    expect(options).toMatchObject({ coordinatorURL: 'https://explicit.invalid', caFile: '/explicit-ca' })
    expect(options).not.toHaveProperty('caPem')
  } finally {
    output.mockRestore()
  }
})

it.each(['up', 'run', 'register', 'reauth'] as const)(
  '%s does not read deployment for an existing identity',
  async (action) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      vi.mocked(loadDeployment).mockRejectedValue(new Error('must not read deployment'))
      if (action === 'register') await expect(runDaemonCLI(action, [])).rejects.toThrow('节点身份已存在')
      else await runDaemonCLI(action, [])
      expect(loadDeployment).not.toHaveBeenCalled()
      expect(registerNode).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  },
)

it('identity reports only public identity fields and handles an unregistered directory without creating it', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runDaemonCLI('identity', [])
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      registered: true,
      employee_id: identity.employee_id,
      node_id: identity.node_id,
      display_name: identity.display_name,
      system: identity.system,
    })
    expect(JSON.stringify(output.mock.calls)).not.toContain(identity.credential.token)
    vi.mocked(loadIdentity).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await runDaemonCLI('identity', [])
    expect(output).toHaveBeenLastCalledWith(JSON.stringify({ registered: false }))
    expect(initializeBrowseRoots).not.toHaveBeenCalled()
    expect(loadDeployment).not.toHaveBeenCalled()
    expect(runDaemon).not.toHaveBeenCalled()
  } finally {
    output.mockRestore()
  }
})

it('run aborts on stdin EOF and removes its listener', async () => {
  const stdin = new PassThrough()
  const started = Promise.withResolvers<void>()
  let aborted = false
  vi.mocked(runDaemon).mockImplementation(() =>
    Effect.tryPromise({
      try: async (signal) => {
        started.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          ),
        )
      },
      catch: () => new Error('unexpected stdin failure'),
    }),
  )
  const running = runDaemonCLI('run', ['--exit-with-stdin'], { stdin })
  await started.promise
  stdin.end()
  await running
  expect(aborted).toBe(true)
  expect(stdin.listenerCount('end')).toBe(0)
})
