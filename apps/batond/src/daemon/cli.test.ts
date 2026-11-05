import { PassThrough } from 'node:stream'
import { Effect } from 'effect'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { runDaemonCLI } from './cli.ts'
import { runDaemon } from './daemon.ts'
import { loadIdentity } from './identity.ts'
import { initializeBrowseRoots } from '../devices/roots.ts'

vi.mock('./daemon.ts', () => ({ runDaemon: vi.fn(() => Effect.void) }))
vi.mock('./identity.ts', () => ({
  defaultDataDirectory: () => '/offline-node',
  isMissing: (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
  loadIdentity: vi.fn(),
}))
vi.mock('../devices/roots.ts', () => ({ initializeBrowseRoots: vi.fn() }))

const identity: NodeIdentity = {
  node_id: '729f92e9-e68c-4a30-817a-0adb2da87b51',
  employee_id: '74b66275-348c-4dd3-ae1d-7f3d21440f70',
  coordinator_url: 'https://center.test',
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
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runDaemon).mockImplementation(() => Effect.void)
  vi.mocked(loadIdentity).mockResolvedValue(identity)
})

it('rejects unknown arguments without echoing them', async () => {
  const result = await runDaemonCLI('run', ['--unknown-option=offline-secret']).catch((error: unknown) => error)
  expect(String(result)).toContain('节点命令参数无效')
  expect(String(result)).not.toContain('offline-secret')
  expect(initializeBrowseRoots).not.toHaveBeenCalled()
  expect(runDaemon).not.toHaveBeenCalled()
})

it.each(['run', 'serve'] as const)('passes the default control budget through %s', async (action) => {
  await runDaemonCLI(action, [])
  expect(runDaemon).toHaveBeenCalledWith(expect.objectContaining({ controlTimeoutSeconds: 370 }))
})

it('uses a local OTLP endpoint without starting a forwarding receiver', async () => {
  const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
  try {
    await runDaemonCLI('run', [])
    expect(vi.mocked(runDaemon).mock.calls.at(-1)?.[0].telemetryRelay).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
  }
})

it('does not send a local signal-specific header to the loopback receiver', async () => {
  const previous = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'authorization=local-header'
  try {
    await runDaemonCLI('run', [])
    expect(vi.mocked(runDaemon).mock.calls.at(-1)?.[0].telemetryRelay).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    else process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = previous
  }
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

it('identity reports only public identity fields and handles an unregistered directory without creating it', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runDaemonCLI('identity', [])
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      registered: true,
      employee_id: identity.employee_id,
      coordinator_url: identity.coordinator_url,
      node_id: identity.node_id,
      display_name: identity.display_name,
      system: identity.system,
    })
    expect(JSON.stringify(output.mock.calls)).not.toContain(identity.credential.token)
    vi.mocked(loadIdentity).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await runDaemonCLI('identity', [])
    expect(output).toHaveBeenLastCalledWith(JSON.stringify({ registered: false }))
    expect(initializeBrowseRoots).not.toHaveBeenCalled()
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
