import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import type { DeploymentConfig } from './deployment.ts'
import { PublicIdentity } from './status.ts'
import { lastFailure } from './supervisor.ts'
import { ThreadDirectory } from './local.ts'

const UpgradeState = Schema.Struct({
  operation_id: Schema.String,
  source_version: Schema.String,
  target_version: Schema.String,
  target_path: Schema.optionalKey(Schema.String),
  phase: Schema.Literals(['draining', 'ready', 'migrating', 'syncing', 'completed', 'cancelled', 'failed']),
  reason: Schema.optionalKey(Schema.String),
  error_code: Schema.optionalKey(Schema.String),
})
export const UpgradeSnapshot = Schema.Struct({
  state: Schema.NullOr(UpgradeState),
  blockers: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['thread', 'runtime', 'process']),
      id: Schema.String,
      reason: Schema.String,
      pid: Schema.optionalKey(Schema.Int),
    }),
  ),
  pending_reports: Schema.Number,
})
export type UpgradeSnapshot = typeof UpgradeSnapshot.Type

export type Spawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams

export class Batond {
  readonly executable: string
  constructor(
    resources: string,
    readonly dataDirectory: string,
    private readonly spawnProcess: Spawn = (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }),
  ) {
    this.executable = join(resources, 'batond', process.platform === 'win32' ? 'batond.exe' : 'batond')
  }

  private spawn(args: string[], code?: string) {
    const env = { ...process.env }
    delete env.BATON_ENROLLMENT_TOKEN
    if (code !== undefined) env.BATON_ENROLLMENT_TOKEN = code
    return this.spawnProcess(this.executable, [...args, '--data-dir', this.dataDirectory], { env, windowsHide: true })
  }

  run() {
    return this.spawn(['run', '--exit-with-stdin'])
  }

  private execute(args: string[], code?: string, upgrade = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, code)
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
      // 迁移由持久状态和进程锁恢复，不因桌面命令超时而中断。
      const timer =
        args[0] === 'upgrade' && args[1] === 'migrate'
          ? undefined
          : setTimeout(() => {
              child.kill()
              finish(new Error('batond 命令超时，请检查本机设备状态后重试'))
            }, 40_000)
      child.stdin.on('error', () => {})
      child.stdin.end()
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 64 * 1024) {
          if (args[0] === 'upgrade' && args[1] === 'migrate') output = output.slice(-64 * 1024)
          else {
            child.kill()
            finish(new Error('batond 输出超过限制'))
          }
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

  async directory(threadId: string): Promise<ThreadDirectory> {
    try {
      return Schema.decodeUnknownSync(ThreadDirectory)(
        JSON.parse(await this.execute(['desktop-directory', '--thread-id', threadId])),
      )
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      throw new Error(
        code === 'directory_missing' ? 'This folder no longer exists.' : 'This thread folder is unavailable.',
      )
    }
  }

  async upgradeStatus(): Promise<UpgradeSnapshot> {
    return Schema.decodeUnknownSync(UpgradeSnapshot)(
      JSON.parse(await this.execute(['upgrade', 'status'], undefined, true)),
    )
  }

  async prepareVersion(version: string) {
    await this.execute(['upgrade', 'prepare', '--version', version], undefined, true)
    return this.upgradeStatus()
  }

  async prepareSelf(packageDirectory: string) {
    await this.execute(['upgrade', 'prepare', '--package', packageDirectory, '--self'], undefined, true)
    return this.upgradeStatus()
  }

  async cancelUpgrade() {
    await this.execute(['upgrade', 'cancel'], undefined, true)
    return this.upgradeStatus()
  }

  async migrate() {
    await this.execute(['upgrade', 'migrate'], undefined, true)
    return this.upgradeStatus()
  }

  async stopThread(id: string) {
    await this.execute(['stop', '--thread-id', id], undefined, true)
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
