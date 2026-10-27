import { BUNDLED } from '@baton/protocol/release'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { isSea } from 'node:sea'
import { Schema } from 'effect'
import { ProjectRuntime, normalizeProjectProvider } from '@baton/protocol'
import {
  spawnOwnedProcess,
  type OwnedProcess,
  type ProcessCommand,
  type ProcessWatchdog,
  type ProcessRecordCallbacks,
  type SpawnOwnedProcessOptions,
} from '../platform/process.ts'
import { captureRuntimeOutput } from './capture.ts'
import { DeviceLoginCode, type ProjectManagerOptions } from './types.ts'
import { readProjectRuntimeConfig } from '../devices/config.ts'
import { probeFingerprint } from './probe-cache.ts'

const runtimeEntry = (): URL => {
  const entry = [
    new URL('../../../../runtimes/project-agent/src/cli.ts', import.meta.url),
    new URL('../../../runtimes/project-agent/src/cli.ts', import.meta.url),
  ].find((candidate) => existsSync(candidate))
  if (!entry) throw new Error('Project Runtime 源码入口不存在，请在已安装依赖的 Baton 仓库中运行')
  return entry
}
export const defaultWatchdogCommand = (): ProcessCommand => {
  if (isSea() || BUNDLED)
    return { file: process.execPath, args: [...(isSea() ? [] : [fileURLToPath(import.meta.url)]), 'watchdog'] }
  const entry = runtimeEntry()
  const require = createRequire(entry)
  return {
    file: process.execPath,
    args: [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      fileURLToPath(new URL('../../../apps/batond/src/project/watchdog-entry.ts', entry)),
    ],
  }
}
export const defaultRuntimeCommand = (): ProcessCommand => {
  if (isSea() || BUNDLED)
    return {
      file: process.execPath,
      args: [...(isSea() ? [] : [fileURLToPath(import.meta.url)]), 'project-runtime'],
    }
  const entry = runtimeEntry()
  const require = createRequire(entry)
  return {
    file: process.execPath,
    args: ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(entry)],
  }
}
const normalizeProvider = normalizeProjectProvider

export class RuntimeRunner {
  private readonly owned = new Set<OwnedProcess>()
  private readonly starting = new Set<Promise<OwnedProcess>>()
  private readonly loginStarts = new Map<string, Promise<DeviceLoginCode>>()
  private readonly logins = new Map<string, { cancel: AbortController; done: Promise<void> }>()
  private closing = false
  private lastProbe: { report: ProjectRuntime; fingerprint: string } | undefined
  constructor(
    private readonly options: ProjectManagerOptions,
    private readonly watchdog: ProcessWatchdog | undefined,
    private readonly records: ProcessRecordCallbacks,
  ) {}
  async spawn(
    args: string[],
    signal: AbortSignal,
    role = `aux:${randomUUID()}`,
    cwd?: string,
    env?: NodeJS.ProcessEnv,
    onSpawn?: SpawnOwnedProcessOptions['onSpawn'],
  ) {
    if (this.closing) throw new Error('Project Runtime 宿主已关闭')
    const command = this.options.runtimeCommand ?? defaultRuntimeCommand()
    const startup = spawnOwnedProcess(
      {
        ...command,
        args: [...(command.args ?? []), ...args],
        ...((cwd ?? command.cwd) ? { cwd: cwd ?? command.cwd! } : {}),
        env: { ...process.env, ...command.env, ...env },
      },
      {
        watchdog: this.watchdog,
        records: this.records,
        signal,
        role,
        onSpawn: (child) => {
          onSpawn?.(child)
          if (args[0] !== 'login') child.stderr.resume()
        },
      },
    )
    this.starting.add(startup)
    try {
      const owned = await startup
      this.owned.add(owned)
      if (this.closing) {
        await this.reap(owned)
        throw new Error('Project Runtime 宿主已关闭')
      }
      return owned
    } finally {
      this.starting.delete(startup)
    }
  }
  async reap(owned: OwnedProcess) {
    const result = await owned.reap()
    if (!result.reaped) throw new Error('Project Runtime 进程树清理未确认')
    this.owned.delete(owned)
  }
  async report(signal?: AbortSignal): Promise<ProjectRuntime | undefined> {
    try {
      return await this.probe(signal)
    } catch (error) {
      if (signal?.aborted || this.closing) return undefined
      const cached = this.lastProbe
      const fingerprint = await probeFingerprint(this.options.runtimeCommand ?? defaultRuntimeCommand()).catch(
        () => undefined,
      )
      if (!cached || !fingerprint || cached.fingerprint !== fingerprint) {
        this.lastProbe = undefined
        return undefined
      }
      const config = await readProjectRuntimeConfig(this.options.dataDir).catch(() => undefined)
      if (!config) return undefined
      return {
        ...cached.report,
        max_concurrent_projects: config.maxConcurrentProjects,
        stale: true,
        probe_error:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'probe_timeout'
            : error instanceof Error && error.message === 'Project Runtime 输出超限'
              ? 'probe_output_limit'
              : 'probe_failed',
      }
    }
  }
  async probe(signal?: AbortSignal): Promise<ProjectRuntime> {
    const config = await readProjectRuntimeConfig(this.options.dataDir)
    const fingerprint = await probeFingerprint(this.options.runtimeCommand ?? defaultRuntimeCommand())
    const capture = new AbortController()
    const bounded = AbortSignal.any([
      capture.signal,
      AbortSignal.timeout(config.probeTimeoutMs),
      ...(signal ? [signal] : []),
    ])
    let output: Promise<Buffer> | undefined
    const owned = await this.spawn(['probe'], bounded, undefined, undefined, undefined, (child) => {
      output = captureRuntimeOutput(child.stdout, config.probeMaxOutputBytes, false, bounded)
      void output.catch((error: unknown) => capture.abort(error))
    })
    const stop = () => {
      void this.reap(owned).catch(() => {})
    }
    bounded.addEventListener('abort', stop, { once: true })
    try {
      bounded.throwIfAborted()
      if (!output) throw new Error('Project Runtime 输出未连接')
      const bytes = await output
      const exit = await owned.exited
      bounded.throwIfAborted()
      if (exit.code !== 0) throw new Error('Project Runtime 状态检查失败')
      const value = Schema.decodeUnknownSync(ProjectRuntime)(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      )
      if (value.providers === null) {
        this.lastProbe = undefined
        throw new Error('Project Runtime 状态报告无效')
      }
      const report: ProjectRuntime = {
        ...value,
        providers: [...value.providers].sort((a, b) => a.provider.localeCompare(b.provider)),
        max_concurrent_projects: config.maxConcurrentProjects,
        probed_at: new Date().toISOString(),
        stale: false,
      }
      const after = await probeFingerprint(this.options.runtimeCommand ?? defaultRuntimeCommand())
      this.lastProbe = fingerprint && fingerprint === after ? { report, fingerprint } : undefined
      return report
    } finally {
      bounded.removeEventListener('abort', stop)
      await this.reap(owned)
    }
  }
  async login(provider: string, signal?: AbortSignal) {
    let owned: OwnedProcess | undefined
    let input: OwnedProcess['stdin'] | undefined
    const stop = () => {
      if (owned) void this.reap(owned).catch(() => {})
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      owned = await this.spawn(
        ['login', normalizeProvider(provider)],
        signal ?? new AbortController().signal,
        undefined,
        undefined,
        undefined,
        (child) => {
          input = child.stdin
          process.stdin.pipe(child.stdin)
          child.stdout.pipe(process.stdout, { end: false })
          child.stderr.pipe(process.stderr, { end: false })
        },
      )
      signal?.throwIfAborted()
      if ((await owned.exited).code !== 0) throw new Error('订阅登录失败')
      signal?.throwIfAborted()
    } finally {
      if (input) process.stdin.unpipe(input)
      signal?.removeEventListener('abort', stop)
      if (owned) await this.reap(owned)
    }
  }
  async startDeviceLogin(provider: string, signal?: AbortSignal, onDone?: () => void): Promise<DeviceLoginCode> {
    provider = normalizeProvider(provider)
    const previous = this.loginStarts.get(provider) ?? Promise.resolve()
    const start = previous.catch(() => {}).then(() => this.startLogin(provider, signal, onDone))
    this.loginStarts.set(provider, start)
    try {
      return await start
    } finally {
      if (this.loginStarts.get(provider) === start) this.loginStarts.delete(provider)
    }
  }
  private async startLogin(provider: string, signal?: AbortSignal, onDone?: () => void): Promise<DeviceLoginCode> {
    signal?.throwIfAborted()
    const old = this.logins.get(provider)
    old?.cancel.abort()
    await old?.done
    const cancel = new AbortController()
    const background = AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60 * 1000)])
    const bounded = AbortSignal.any([background, AbortSignal.timeout(10000), ...(signal ? [signal] : [])])
    let output!: Promise<DeviceLoginCode>
    const owned = await this.spawn(['login-device', provider], bounded, undefined, undefined, undefined, (child) => {
      output = captureRuntimeOutput(child.stdout, 16 * 1024, true, bounded).then((bytes) => {
        const code = Schema.decodeUnknownSync(DeviceLoginCode)(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        )
        if (code.provider !== provider) throw new Error('订阅登录服务不符')
        return code
      })
      void output.catch((error: unknown) => cancel.abort(error))
    })
    const stop = () => {
      void this.reap(owned).catch(() => {})
    }
    background.addEventListener('abort', stop, { once: true })
    if (background.aborted) stop()
    const done = owned.exited
      .then(async () => {
        background.removeEventListener('abort', stop)
        await this.reap(owned)
      })
      .finally(() => {
        if (this.logins.get(provider)?.cancel === cancel) this.logins.delete(provider)
        onDone?.()
        this.options.onReportChanged?.()
      })
    this.logins.set(provider, { cancel, done })
    void done.catch(() => {})
    try {
      bounded.throwIfAborted()
      return await output
    } catch (error) {
      cancel.abort()
      await done.catch(() => {})
      throw error
    }
  }
  async close() {
    this.closing = true
    for (const login of this.logins.values()) login.cancel.abort()
    await Promise.allSettled(this.starting)
    await Promise.all([...this.owned].map((p) => this.reap(p)))
    await Promise.allSettled(this.loginStarts.values())
    await Promise.all([...this.logins.values()].map((p) => p.done))
  }
}
