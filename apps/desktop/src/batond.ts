import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { join } from 'node:path'
import { Schema } from 'effect'
import { SignedUpdateManifest } from '@baton/protocol/update-manifest'
import { programRoot } from './layout.ts'

export type Spawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams

export interface CommandFailure {
  code?: string
  message?: string
}

export function lastFailure(stderr: string): CommandFailure {
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

// 桌面只调用一次性维护命令；设备身份、登录和控制通道都由本机 daemon 负责。
export class Batond {
  readonly executable: string
  private command: { executable: string; args: string[] } | undefined
  constructor(
    resources: string,
    readonly dataDirectory: string,
    private readonly spawnProcess: Spawn = (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }),
  ) {
    this.executable = batondExecutable(resources)
  }

  private spawn(args: string[], bootstrap = false) {
    const command = !bootstrap && this.command ? this.command : { executable: this.executable, args: [] }
    return this.spawnProcess(command.executable, [...command.args, ...args, '--data-dir', this.dataDirectory], {
      env: { ...process.env },
      windowsHide: true,
    })
  }

  private execute(args: string[], upgrade = false, stdin?: string, bootstrap = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, bootstrap)
      let output = '',
        stderr = '',
        complete = false
      const finish = (error?: Error) => {
        if (complete) return
        complete = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(output)
      }
      const timer = setTimeout(
        () => {
          child.kill()
          finish(new Error('batond 命令超时，请检查本机设备状态后重试'))
        },
        args[0] === 'update' && args[1] === 'desktop-download' ? 30 * 60_000 : 40_000,
      )
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 64 * 1024) {
          child.kill()
          finish(new Error('batond 输出超过限制'))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
      })
      child.once('error', () => finish(new Error('无法运行内置 batond，请重新安装客户端')))
      child.once('close', (exit) => {
        if (exit === 0) finish()
        else {
          const failure = lastFailure(stderr)
          // 子进程的原始输出不返回网页；诊断只保留稳定的错误码。
          finish(
            Object.assign(
              new Error(
                upgrade
                  ? `${failure.code ?? 'upgrade_failed'}：${failure.message ?? '升级操作失败，请检查日志'}`
                  : 'batond 操作失败，请检查设备状态或日志',
              ),
              {
                code: failure.code ?? 'batond_failed',
              },
            ),
          )
        }
      })
    })
  }

  async bootstrap(): Promise<void> {
    const command = Schema.decodeUnknownSync(
      Schema.Struct({ executable: Schema.String, args: Schema.Array(Schema.String) }),
    )(JSON.parse(await this.execute(['update', 'bootstrap'], true, undefined, true)))
    const expected = batondExecutable(programRoot(this.dataDirectory), 'launcher')
    if (
      command.executable !== expected ||
      JSON.stringify(command.args) !== JSON.stringify(['dispatch', '--data-dir', this.dataDirectory, '--'])
    )
      throw new Error('设备更新入口无效')
    this.command = { executable: command.executable, args: [...command.args] }
    await this.execute(['env', 'init', ...(process.platform === 'win32' ? [] : ['--shell'])])
  }

  async update(): Promise<void> {
    await this.execute(['update'], true)
  }

  async cancelUpdate(): Promise<void> {
    await this.execute(['update', 'cancel'], true)
  }

  async updatePolicy(policy?: 'manual' | 'idle'): Promise<'manual' | 'idle'> {
    const result = Schema.decodeUnknownSync(Schema.Struct({ policy: Schema.Literals(['manual', 'idle']) }))(
      JSON.parse(await this.execute(['update', 'policy', ...(policy ? [policy] : [])], true)),
    )
    return result.policy
  }

  async updateManifest(): Promise<typeof SignedUpdateManifest.Type> {
    const value = Schema.decodeUnknownSync(Schema.Struct({ manifest: SignedUpdateManifest }))(
      JSON.parse(await this.execute(['update', 'manifest'], true)),
    )
    return value.manifest
  }

  async downloadDesktopFeed(
    operationId: string,
    attempt: number,
  ): Promise<{
    version: string
    commit: string
    artifacts: ReadonlyArray<{
      path: string
      file: string
      size: number
      sha256: string
      kind: string
      platform: string
      arch: string
    }>
  }> {
    return Schema.decodeUnknownSync(
      Schema.Struct({
        version: Schema.String,
        commit: Schema.String,
        artifacts: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            file: Schema.String,
            size: Schema.Number,
            sha256: Schema.String,
            kind: Schema.String,
            platform: Schema.String,
            arch: Schema.String,
          }),
        ),
      }),
    )(
      JSON.parse(
        await this.execute(
          ['update', 'desktop-feed', '--operation-id', operationId, '--attempt', String(attempt)],
          true,
        ),
      ),
    )
  }

  async updateStatus(): Promise<{
    operation_id: string
    attempt: number
    phase: string
    source_version?: string
    target_version?: string
    reason?: string
    rollback_complete?: boolean
  } | null> {
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        state: Schema.NullOr(
          Schema.Struct({
            operation_id: Schema.String,
            attempt: Schema.Number,
            phase: Schema.String,
            source_version: Schema.optionalKey(Schema.String),
            target_version: Schema.optionalKey(Schema.String),
            reason: Schema.optionalKey(Schema.String),
            rollback_complete: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      }),
    )(JSON.parse(await this.execute(['update', 'status'], true)))
    return result.state
  }

  async setModelConnectionKey(connectionId: string, key: string): Promise<void> {
    await this.execute(['project-runtime', 'connection-key', connectionId], false, key)
  }
}

export function batondExecutable(resources: string, directory = 'batond') {
  return join(resources, directory, process.platform === 'win32' ? 'batond.exe' : 'batond')
}
