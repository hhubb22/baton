import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { join } from 'node:path'

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
  constructor(
    resources: string,
    readonly dataDirectory: string,
    private readonly spawnProcess: Spawn = (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }),
  ) {
    this.executable = batondExecutable(resources)
  }

  private spawn(args: string[]) {
    return this.spawnProcess(this.executable, [...args, '--data-dir', this.dataDirectory], {
      env: { ...process.env },
      windowsHide: true,
    })
  }

  private execute(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args)
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
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('batond 命令超时，请检查本机设备状态后重试'))
      }, 40_000)
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
            Object.assign(new Error('batond 操作失败，请检查设备状态或日志'), {
              code: failure.code ?? 'batond_failed',
            }),
          )
        }
      })
    })
  }

  async bootstrap(): Promise<void> {
    await this.execute(['env', 'init', ...(process.platform === 'win32' ? [] : ['--shell'])])
  }

  async setModelConnectionKey(connectionId: string, key: string): Promise<void> {
    await this.execute(['project-runtime', 'connection-key', connectionId], key)
  }
}

export function batondExecutable(resources: string, directory = 'batond') {
  return join(resources, directory, process.platform === 'win32' ? 'batond.exe' : 'batond')
}
