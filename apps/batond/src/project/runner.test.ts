import { rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Scope, Exit } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeProjectManager } from './index.ts'
import { RuntimeRunner, defaultRuntimeCommand, defaultWatchdogCommand } from './runner.ts'
import { LeaseClock, success } from './types.ts'
import { serveRuntime } from './stdio.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const open = async (mode = 'idle', real = false) => {
  const dataDir = await makePrivateTempDirectory('baton-runtime-probe-')
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  if (real) {
    // 源码 CLI 通过 tsx 加载依赖，为并行测试下的冷启动预留时间。
    await writePrivateFileAtomic(join(dataDir, 'project-runtime.json'), JSON.stringify({ probeTimeoutMs: 20000 }))
  }
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
      runtimeCommand: {
        ...base,
        env: { ...base.env, BATON_PROJECT_RUNTIME_DATA_DIR: join(dataDir, 'credentials') },
      },
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  return manager
}
const quickRunner = async (
  program: string,
  credentialsDirectory?: string,
  telemetry?: import('@baton/telemetry').DynamicTelemetry,
) => {
  const dataDir = await makePrivateTempDirectory('baton-early-output-')
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const runner = new RuntimeRunner(
    {
      dataDir,
      ...(telemetry ? { telemetry } : {}),
      runtimeCommand: {
        file: process.execPath,
        args: ['-e', program],
        ...(credentialsDirectory ? { env: { BATON_PROJECT_RUNTIME_DATA_DIR: credentialsDirectory } } : {}),
      },
    },
    process.platform === 'win32'
      ? undefined
      : {
          pid: process.pid,
          register: async () => {},
          unregister: async () => {},
          close: async () => {},
        },
    {
      add: async (record) => {
        await delay(200)
        await writePrivateFileAtomic(join(dataDir, `${record.pid}.json`), JSON.stringify(record))
      },
      remove: async (record) => {
        await rm(join(dataDir, `${record.pid}.json`), { force: true })
      },
    },
  )
  cleanups.push(() => runner.close())
  return { runner, dataDir }
}
it('passes current telemetry headers to Runtime through its environment', async () => {
  const telemetry: import('@baton/telemetry').DynamicTelemetry = {
    current: { endpoint: 'http://collector.invalid', headers: 'authorization=remote-key' },
  }
  const { runner } = await quickRunner(
    'console.log(JSON.stringify({headers:process.env.OTEL_EXPORTER_OTLP_HEADERS,argv:process.argv}))',
    undefined,
    telemetry,
  )
  const old = process.env.OTEL_EXPORTER_OTLP_HEADERS
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
  try {
    let output = ''
    let outputEnded: Promise<void> | undefined
    const owned = await runner.spawn(
      ['run'],
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      (child) => {
        outputEnded = new Promise((resolve) => child.stdout.once('end', resolve))
        child.stdout.on('data', (chunk) => {
          output += String(chunk)
        })
      },
    )
    await outputEnded
    await runner.reap(owned)
    const result = JSON.parse(output) as { headers: string; argv: string[] }
    expect(result.headers).toBe('authorization=remote-key')
    expect(result.argv.join(' ')).not.toContain('remote-key')
  } finally {
    if (old === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = old
  }
})
it('uses file URLs for source Runtime and watchdog import loaders', () => {
  for (const command of [defaultRuntimeCommand(), defaultWatchdogCommand()]) {
    expect(command.args?.[0]).toBe('--import')
    expect(new URL(command.args![1]!).protocol).toBe('file:')
  }
})

it.each(['probe', 'login-device'] as const)(
  'captures fast %s output while process registration is delayed',
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
it.each(['probe', 'login-device'] as const)(
  'bounds %s output during delayed process registration',
  async (operation) => {
    const { runner } = await quickRunner('process.stdout.write("x".repeat(70 * 1024)); setInterval(() => {}, 1000)')
    await expect(operation === 'probe' ? runner.probe() : runner.startDeviceLogin('openai-codex')).rejects.toThrow(
      '输出超限',
    )
  },
)
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
  const directory = await makePrivateTempDirectory('baton-probe-cache-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const mode = join(directory, 'mode')
  const credentials = join(directory, 'credentials')
  await ensurePrivateDirectory(credentials)
  const credential = join(credentials, 'openai-codex.json')
  await writePrivateFileAtomic(credential, '{}')
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
  // probeTimeoutMs 同时约束正常探测与超时场景。Windows 启动子进程更慢，正常路径需要更大预算，
  // 但超时场景要等满该预算，因此不能放得太大。
  await writePrivateFileAtomic(
    join(dataDir, 'project-runtime.json'),
    JSON.stringify({ probeTimeoutMs: process.platform === 'win32' ? 5000 : 2000 }),
  )
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
  if (process.platform !== 'win32') {
    await chmod(credential, 0o644)
    expect(await runner.report()).toBeUndefined()
    await chmod(credential, 0o600)
    await writeFile(mode, 'ok')
    await runner.probe()
    await writeFile(mode, 'output')
  }
  await writePrivateFileAtomic(credential, '{"updated":true}')
  expect(await runner.report()).toBeUndefined()
  await writeFile(mode, 'ok')
  await runner.probe()
  await writeFile(mode, 'output')
  await rm(credential)
  expect(await runner.report()).toBeUndefined()
}, 60000)

it('probes the existing Runtime source CLI using only an empty local credential directory', async () => {
  const manager = await open('idle', true)
  const report = await manager.probe()
  expect(report.version).toBe('development')
  expect(report.providers?.map((p) => [p.provider, p.status])).toEqual([
    ['anthropic', 'login_required'],
    ['openai-codex', 'login_required'],
    ['xai', 'login_required'],
  ])
}, 30000)
it('rejects invalid probes and omits invalid runtime reports', async () => {
  const manager = await open('bad-probe')
  await expect(manager.probe()).rejects.toThrow('状态报告无效')
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
