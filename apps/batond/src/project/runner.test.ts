import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Scope, Exit } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import { makeProjectManager } from './index.ts'
import { RuntimeRunner, defaultRuntimeCommand } from './runner.ts'
import { LeaseClock, success } from './types.ts'
import { serveRuntime } from './stdio.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const open = async (mode = 'idle', real = false) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baton-runtime-probe-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const scope = Scope.makeUnsafe()
  const base = real
    ? defaultRuntimeCommand()
    : {
        file: process.execPath,
        args: [fileURLToPath(new URL('../testing/project/runtime.mjs', import.meta.url)), mode],
      }
  const manager = await Effect.runPromise(
    makeProjectManager({
      dataDir,
      runtimeCommand: { ...base, env: { BATON_PROJECT_RUNTIME_DATA_DIR: join(dataDir, 'credentials') } },
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  return manager
}
const quickRunner = async (program: string, credentialsDirectory?: string) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baton-early-output-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const runner = new RuntimeRunner(
    {
      dataDir,
      runtimeCommand: {
        file: process.execPath,
        args: ['-e', program],
        ...(credentialsDirectory ? { env: { BATON_PROJECT_RUNTIME_DATA_DIR: credentialsDirectory } } : {}),
      },
    },
    {
      pid: process.pid,
      register: async () => {
        await delay(200)
      },
      unregister: async () => {},
      close: async () => {},
    },
    { add: async () => {}, remove: async () => {} },
  )
  cleanups.push(() => runner.close())
  return { runner, dataDir }
}
it.each(['probe', 'login-device'] as const)(
  'captures fast %s output while watchdog registration is delayed',
  async (operation) => {
    const value =
      operation === 'probe'
        ? { version: '0.1.0', providers: [{ provider: 'openai-codex', status: 'available' }] }
        : {
            type: 'device_code',
            provider: 'openai-codex',
            verification_uri: 'https://login.invalid/device',
            user_code: 'FAST-CODE',
            expires_in_seconds: 600,
          }
    const { runner } = await quickRunner(`console.log(JSON.stringify(${JSON.stringify(value)}))`)
    const result = operation === 'probe' ? await runner.probe() : await runner.startDeviceLogin('openai-codex')
    expect(result).toMatchObject(value)
  },
)
it.each(['probe', 'login-device'] as const)('bounds %s output during delayed registration', async (operation) => {
  const { runner } = await quickRunner('process.stdout.write("x".repeat(70 * 1024)); setInterval(() => {}, 1000)')
  await expect(operation === 'probe' ? runner.probe() : runner.startDeviceLogin('openai-codex')).rejects.toThrow(
    '输出超限',
  )
})
it('captures stdio frames before a fast Runtime exits during registration', async () => {
  const { runner } = await quickRunner('console.log(JSON.stringify({id:1,request:{operation:"bootstrap"}}))')
  const cancel = new AbortController()
  let serving: Promise<void> | undefined,
    requests = 0
  const owned = await runner.spawn(['run'], cancel.signal, undefined, undefined, undefined, (child) => {
    serving = serveRuntime(
      child.stdout,
      child.stdin,
      async (request) => {
        expect(request.operation).toBe('bootstrap')
        requests++
        return success({})
      },
      cancel.signal,
    )
    void serving.catch(() => {})
  })
  // Runtime may exit before the response is written; this test verifies input capture.
  await serving?.catch(() => {})
  expect(requests).toBe(1)
  await runner.reap(owned)
  cancel.abort()
})

it('uses max(hrtime,wall) for sleep, backward wall clock and forward clock jumps', () => {
  let wall = 100,
    mono = 100
  const clock = new LeaseClock({ wall: () => wall, monotonic: () => mono })
  wall += 5000
  mono += 50
  expect(clock.now()).toBe(5000)
  mono += 6000
  wall -= 10000
  expect(clock.now()).toBe(6050)
  wall = Number.NaN
  expect(() => clock.now()).toThrow('时钟不可用')
})
it('retains a timestamped report after probe timeout and invalidates it when credentials change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-probe-cache-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const mode = join(directory, 'mode')
  const credentials = join(directory, 'credentials')
  await mkdir(credentials, { mode: 0o700 })
  const credential = join(credentials, 'openai-codex.json')
  await writeFile(credential, '{}', { mode: 0o600 })
  const { runner, dataDir } = await quickRunner(
    `
    const fs = require('node:fs');
    const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, 'utf8') : 'ok';
    if (mode === 'timeout') setInterval(() => {}, 1000);
    else if (mode === 'output') process.stdout.write('x'.repeat(70 * 1024));
    else console.log(JSON.stringify({version:'0.1.0',providers:[{provider:'openai-codex',status:mode === 'ok' ? 'available' : mode}]}));
  `,
    credentials,
  )
  await writeFile(join(dataDir, 'project-runtime.json'), JSON.stringify({ probeTimeoutMs: 2000 }), { mode: 0o600 })
  const initial = await runner.report()
  expect(initial).toMatchObject({ stale: false })
  expect(initial?.probed_at).toBeDefined()
  await writeFile(mode, 'timeout')
  expect(await runner.report()).toMatchObject({
    stale: true,
    probed_at: initial?.probed_at,
    probe_error: 'probe_timeout',
  })
  await writeFile(mode, 'login_required')
  expect(await runner.report()).toMatchObject({ stale: false, providers: [{ status: 'login_required' }] })
  await writeFile(mode, 'timeout')
  expect(await runner.report()).toMatchObject({ stale: true, providers: [{ status: 'login_required' }] })
  await writeFile(mode, 'output')
  expect(await runner.report()).toMatchObject({ stale: true, probe_error: 'probe_output_limit' })
  await expect(runner.probe()).rejects.toThrow('输出超限')
  await chmod(credential, 0o644)
  expect(await runner.report()).toBeUndefined()
  await chmod(credential, 0o600)
  await writeFile(mode, 'ok')
  await runner.probe()
  await writeFile(mode, 'output')
  await rm(credential)
  expect(await runner.report()).toBeUndefined()
}, 30000)

it('probes the existing Runtime source CLI using only an empty local credential directory', async () => {
  const manager = await open('idle', true)
  const report = await manager.probe()
  expect(report.version).toBe('0.1.0')
  expect(report.providers?.map((p) => [p.provider, p.status])).toEqual([
    ['anthropic', 'login_required'],
    ['openai-codex', 'login_required'],
    ['xai', 'login_required'],
  ])
})
it('rejects incompatible probes and omits invalid runtime reports', async () => {
  const manager = await open('bad-probe')
  await expect(manager.probe()).rejects.toThrow('版本不匹配')
  expect(await manager.report()).toBeUndefined()
})
it('keeps device login running after code delivery, replaces the same provider and refreshes on exit', async () => {
  const manager = await open()
  let done = 0
  const cancel = new AbortController()
  const code = await manager.startDeviceLogin('ChatGPT', cancel.signal, () => done++)
  expect(code).toMatchObject({
    provider: 'openai-codex',
    user_code: 'LOCAL-CODE',
    verification_uri: 'https://login.invalid/device',
  })
  cancel.abort()
  await delay(20)
  expect(done).toBe(0)
  await Promise.all([
    manager.startDeviceLogin('openai-codex', undefined, () => done++),
    manager.startDeviceLogin('openai-codex', undefined, () => done++),
  ])
  expect(done).toBe(2)
  await manager.close()
  expect(done).toBe(3)
})
