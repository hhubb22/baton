import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { SignedUpdateManifest } from '@baton/protocol/update-manifest'
import type { DeploymentConfig } from './deployment.ts'
import { programRoot } from './layout.ts'
import { PublicIdentity } from './status.ts'
import { lastFailure } from './supervisor.ts'
import { ThreadDirectory } from './local.ts'

export type Spawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams

export class Batond {
  readonly executable: string
  private command: { executable: string; args: string[] } | undefined
  constructor(
    resources: string,
    readonly dataDirectory: string,
    private readonly spawnProcess: Spawn = (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }),
  ) {
    this.executable = join(resources, 'batond', process.platform === 'win32' ? 'batond.exe' : 'batond')
  }

  private spawn(args: string[], code?: string, bootstrap = false) {
    const env = { ...process.env }
    delete env.BATON_ENROLLMENT_TOKEN
    if (args[0] === 'run') env.BATON_DESKTOP_MANAGED = '1'
    if (code !== undefined) env.BATON_ENROLLMENT_TOKEN = code
    const command = !bootstrap && this.command ? this.command : { executable: this.executable, args: [] }
    return this.spawnProcess(command.executable, [...command.args, ...args, '--data-dir', this.dataDirectory], {
      env,
      windowsHide: true,
    })
  }

  run() {
    return this.spawn(['run', '--exit-with-stdin'])
  }

  private execute(args: string[], code?: string, upgrade = false, stdin?: string, bootstrap = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, code, bootstrap)
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
          // 子进程的原始输出不返回网页，注册秘密只存在于子进程环境中。
          finish(
            Object.assign(
              new Error(
                upgrade
                  ? `${failure.code ?? 'upgrade_failed'}：${failure.message ?? '升级操作失败，请检查日志'}`
                  : failure.code === 'enrollment_expired'
                    ? '接入凭据已过期，请在中心重新领取'
                    : 'batond 操作失败，请检查设备状态或重新领取接入凭据',
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
    )(JSON.parse(await this.execute(['update', 'bootstrap'], undefined, true, undefined, true)))
    const expected = join(
      programRoot(this.dataDirectory),
      'launcher',
      process.platform === 'win32' ? 'batond.exe' : 'batond',
    )
    if (
      command.executable !== expected ||
      JSON.stringify(command.args) !== JSON.stringify(['dispatch', '--data-dir', this.dataDirectory, '--'])
    )
      throw new Error('设备更新入口无效')
    this.command = { executable: command.executable, args: [...command.args] }
    await this.execute(['env', 'init', ...(process.platform === 'win32' ? [] : ['--shell'])])
  }

  async update(): Promise<void> {
    await this.execute(['update'], undefined, true)
  }

  async cancelUpdate(): Promise<void> {
    await this.execute(['update', 'cancel'], undefined, true)
  }

  async reportUpdateStartupFailure(operationId: string, attempt: number): Promise<void> {
    await this.execute(
      ['update', 'startup-failed', '--operation-id', operationId, '--attempt', String(attempt)],
      undefined,
      true,
    )
  }

  async updatePolicy(policy?: 'manual' | 'idle'): Promise<'manual' | 'idle'> {
    const result = Schema.decodeUnknownSync(Schema.Struct({ policy: Schema.Literals(['manual', 'idle']) }))(
      JSON.parse(await this.execute(['update', 'policy', ...(policy ? [policy] : [])], undefined, true)),
    )
    return result.policy
  }

  async updateManifest(): Promise<typeof SignedUpdateManifest.Type> {
    const value = Schema.decodeUnknownSync(Schema.Struct({ manifest: SignedUpdateManifest }))(
      JSON.parse(await this.execute(['update', 'manifest'], undefined, true)),
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
          undefined,
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
    )(JSON.parse(await this.execute(['update', 'status'], undefined, true)))
    return result.state
  }

  async setModelConnectionKey(connectionId: string, key: string): Promise<void> {
    await this.execute(['project-runtime', 'connection-key', connectionId], undefined, false, key)
  }

  async directory(threadId: string): Promise<ThreadDirectory> {
    try {
      return Schema.decodeUnknownSync(ThreadDirectory)(
        JSON.parse(await this.execute(['desktop-directory', '--thread-id', threadId])),
      )
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      throw new Error(code === 'directory_missing' ? '此文件夹已不存在。' : '此对话的文件夹不可用。')
    }
  }

  async identity(): Promise<PublicIdentity> {
    return Schema.decodeUnknownSync(PublicIdentity)(JSON.parse(await this.execute(['identity'])))
  }

  async enroll(config: DeploymentConfig, userData: string, code: string, displayName: string) {
    const args = ['register', '--coordinator', config.coordinator_url, '--display-name', displayName]
    if (config.ca_pem !== undefined) args.push('--ca-file', join(userData, 'ca.pem'))
    await this.execute(args, code)
    return this.identity()
  }

  async reauth(config: DeploymentConfig, userData: string, code: string) {
    const args = ['reauth']
    if (config.ca_pem !== undefined) args.push('--ca-file', join(userData, 'ca.pem'))
    await this.execute(args, code)
    return this.identity()
  }
}

export function daemonLog(directory: string, failed: (error: unknown) => void) {
  const file = join(directory, 'logs', 'desktop-batond.log')
  let serial: Promise<void> = Promise.resolve()
  return {
    write(chunk: Buffer) {
      serial = serial
        .then(async () => {
          await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 })
          const size = await stat(file)
            .then((value) => value.size)
            .catch((error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
              throw error
            })
          if (size + chunk.length > 10 * 1024 * 1024) {
            await rename(file, file + '.1').catch((error: unknown) => {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
            })
          }
          await appendFile(file, chunk, { mode: 0o600 })
        })
        .catch(failed)
    },
    async flush() {
      await serial
    },
  }
}
