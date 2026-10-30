import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SupervisorState } from './status.ts'

export interface DaemonFailure {
  code?: string
  message?: string
}
export function isUpdateStartupFailure(info: {
  code: number | null
  signal: NodeJS.Signals | null
  failure: DaemonFailure
}) {
  return (
    info.code !== null &&
    info.code !== 0 &&
    info.signal === null &&
    [
      'storage_version_unsupported',
      'migration_checksum_mismatch',
      'upgrade_migration_failed',
      'upgrade_package_invalid',
    ].includes(info.failure.code ?? '')
  )
}
const terminal = new Set([
  'needs_reauth',
  'node_version_incompatible',
  'deployment_invalid',
  'identity_recovery_required',
])

export function restartDecision(
  exitCode: number | null,
  failure: DaemonFailure,
  failures: number[],
  now: number,
  attempt?: number,
) {
  if (failure.code === 'daemon_running') return { state: 'external' as const, delay: 30_000, failures: [] }
  if (exitCode === 78 || (failure.code && terminal.has(failure.code)))
    return { state: 'rejected' as const, failures: [] }
  const recent = [...failures.filter((time) => now - time < 60_000), now]
  if (recent.length >= 5) return { state: 'rejected' as const, failures: recent }
  return {
    state: 'restarting' as const,
    delay: Math.min(30_000, 1000 * 2 ** (attempt ?? recent.length - 1)),
    failures: recent,
  }
}

export function lastFailure(stderr: string): DaemonFailure {
  try {
    const value: unknown = JSON.parse(stderr.trim().split('\n').at(-1) ?? '')
    if (typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string')
      return {
        code: value.code,
        ...('message' in value && typeof value.message === 'string' ? { message: value.message } : {}),
      }
  } catch {
    /* stderr 可能包含普通诊断行。 */
  }
  return {}
}

export class Supervisor {
  state: SupervisorState = { state: 'stopped' }
  lastExit: { at: string; reason: string } | null = null
  private child: ChildProcessWithoutNullStreams | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private generation = 0
  private stopReason: string | undefined
  private failures: number[] = []
  private attempt = 0
  private startedAt = 0
  private closed: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      spawn: () => ChildProcessWithoutNullStreams
      changed: (state: SupervisorState) => void
      log: (chunk: Buffer) => void
      unexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null; failure: DaemonFailure }) => void
      now?: () => number
    },
  ) {}

  private update(state: SupervisorState) {
    this.state = state
    this.options.changed(state)
  }

  reject(code: string, message: string) {
    this.update({ state: 'rejected', code, message })
  }

  start() {
    if (this.child || this.timer) return
    this.generation++
    this.stopped = false
    this.stopReason = undefined
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.options.spawn()
    } catch {
      const failure = { code: 'spawn_failed', message: '无法启动内置 batond' }
      this.recordExit(null, null, failure)
      this.exited(null, failure)
      return
    }
    this.child = child
    this.startedAt = (this.options.now ?? Date.now)()
    child.stdin.on('error', () => {})
    this.update({ state: 'connecting', ...(child.pid ? { pid: child.pid } : {}) })
    let stderr = ''
    const completion = Promise.withResolvers<void>()
    this.closed = completion.promise
    child.stdout.on('data', (chunk: Buffer) => this.options.log(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.log(chunk)
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
    })
    child.once('error', () => {
      stderr = JSON.stringify({ code: 'spawn_failed', message: '无法启动内置 batond' })
    })
    child.once('close', (code, signal) => {
      const failure = lastFailure(stderr)
      this.recordExit(code, signal, failure, stderr)
      this.child = undefined
      completion.resolve()
      if (this.stopped) return
      this.options.unexpectedExit?.({ code, signal, failure })
      this.exited(code, failure)
    })
  }

  private recordExit(code: number | null, signal: NodeJS.Signals | null, failure: DaemonFailure, stderr = '') {
    const knownCode =
      failure.code && (terminal.has(failure.code) || ['daemon_running', 'spawn_failed'].includes(failure.code))
        ? failure.code
        : undefined
    const publicReason =
      knownCode === 'needs_reauth' ? '登录已过期' : knownCode === 'deployment_invalid' ? '连接设置无效' : knownCode
    // stderr 的字段名和敏感值可能分行；最近退出只保留已知错误码与固定说明。
    const detail =
      knownCode === 'spawn_failed' ? '无法启动内置 batond' : stderr.trim() ? 'batond 报告了错误，请查看日志' : undefined
    this.lastExit = {
      at: new Date((this.options.now ?? Date.now)()).toISOString(),
      reason: [
        `batond ${this.stopReason ?? '已退出'} (退出码: ${code ?? '无'}, 信号: ${signal ?? '无'})`,
        publicReason,
        detail,
      ]
        .filter(Boolean)
        .join('; '),
    }
  }

  private exited(code: number | null, failure: DaemonFailure) {
    const now = (this.options.now ?? Date.now)()
    if (now - this.startedAt >= 60_000) this.attempt = 0
    const decision = restartDecision(code, failure, this.failures, now, this.attempt)
    this.attempt = decision.state === 'restarting' ? this.attempt + 1 : 0
    this.failures = decision.failures
    this.update({
      state: decision.state,
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.message
        ? { message: failure.message }
        : decision.state === 'rejected'
          ? { message: 'batond 在 60 秒内连续失败 5 次，请检查日志后重启' }
          : {}),
    })
    if (decision.delay !== undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (!this.stopped) this.start()
      }, decision.delay)
  }

  async stop(reason = '已由客户端停止'): Promise<void> {
    const generation = ++this.generation
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.update({ state: 'stopping' })
    const child = this.child
    if (child) {
      this.stopReason = reason
      child.stdin.end()
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 15_000)
        }),
      ])
      if (timeout) clearTimeout(timeout)
    }
    if (generation === this.generation) this.update({ state: 'stopped' })
  }

  async restart(shouldStart: () => boolean = () => true) {
    const stopping = this.stop('已停止以便重启')
    const generation = this.generation
    await stopping
    if (generation !== this.generation || !shouldStart()) return
    if (this.child) {
      this.stopped = false
      this.failures = []
      this.attempt = 0
      return
    }
    this.failures = []
    this.attempt = 0
    this.start()
  }
}
