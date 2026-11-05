import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireProcessLock, processLockIsHeld, ProcessLockBusy } from '../platform/lock.ts'
import {
  ensurePrivateDirectory,
  openPrivateFile,
  readPrivateFile,
  writePrivateFileAtomic,
} from '../platform/private.ts'
import { currentBatondCommand, type BatondCommand } from './host.ts'
import {
  controlPaths,
  decodeControlRequest,
  decodeControlResponse,
  type ControlRequest,
  type ControlResponse,
} from './control.ts'
import { IPCError, requestAuthenticated } from './ipc.ts'
import { isMissing } from './identity.ts'

export interface ControlClientOptions {
  readonly command?: BatondCommand
  readonly readyTimeoutMs?: number
  /** Launch injection keeps readiness and concurrency tests local and deterministic. */
  readonly start?: (dataDirectory: string) => Promise<void>
}

async function launchDaemon(dataDirectory: string, command: BatondCommand): Promise<void> {
  const logs = join(dataDirectory, 'logs')
  await ensurePrivateDirectory(logs)
  const filename = join(logs, 'batond.log')
  try {
    if ((await stat(filename)).size >= 10 * 1024 * 1024) await rename(filename, `${filename}.1`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  try {
    const file = await openPrivateFile(filename)
    await file.close()
  } catch (error) {
    if (!isMissing(error)) throw error
    await writePrivateFileAtomic(filename, '')
  }
  const log = await openPrivateFile(filename, constants.O_WRONLY | constants.O_APPEND)
  try {
    const child = spawn(command.executable, [...command.args, 'serve', '--data-dir', dataDirectory], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } finally {
    await log.close()
  }
}

/** All local controllers use the same token, endpoint and serialized autostart lock. */
export class ControlClient {
  constructor(
    readonly dataDirectory: string,
    readonly options: ControlClientOptions = {},
  ) {}

  private async send(request: ControlRequest, timeoutMs = 1000): Promise<ControlResponse> {
    const paths = controlPaths(this.dataDirectory)
    const token = (await readPrivateFile(paths.token)).toString('utf8')
    if (!/^[a-f0-9]{64}$/.test(token)) throw new IPCError('invalid_token', '本机控制令牌无效')
    return requestAuthenticated({
      endpoint: paths.endpoint,
      token,
      request,
      decodeRequest: decodeControlRequest,
      decodeResponse: decodeControlResponse,
      timeoutMs,
    })
  }

  async ensureDaemon(): Promise<void> {
    const ready = async () => {
      try {
        return (await this.send({ method: 'status' }, 300)).ok
      } catch (error) {
        if (
          isMissing(error) ||
          (error instanceof IPCError && ['unreachable', 'closed', 'timeout', 'unauthorized'].includes(error.code))
        )
          return false
        throw error
      }
    }
    if (await ready()) return
    await ensurePrivateDirectory(this.dataDirectory)
    const deadline = performance.now() + (this.options.readyTimeoutMs ?? (process.platform === 'win32' ? 10000 : 5000))
    const lock = join(this.dataDirectory, 'autostart.lock')
    while (performance.now() < deadline) {
      let release: (() => Promise<void>) | undefined
      try {
        release = await acquireProcessLock(lock)
        if (await ready()) return
        // A daemon still initializing owns its endpoint. Wait for it instead of spawning a rival.
        if (!(await processLockIsHeld(join(this.dataDirectory, 'daemon.lock')))) {
          await (
            this.options.start ??
            ((directory) => launchDaemon(directory, this.options.command ?? currentBatondCommand()))
          )(this.dataDirectory)
        }
        let backoff = 50
        while (performance.now() < deadline) {
          if (await ready()) return
          await delay(Math.min(backoff, Math.max(1, deadline - performance.now())))
          backoff = Math.min(200, backoff * 2)
        }
      } catch (error) {
        if (!(error instanceof ProcessLockBusy)) throw error
      } finally {
        await release?.()
      }
      if (await ready()) return
      await delay(50)
    }
    throw new IPCError('daemon_not_ready', '本机守护进程未能及时启动，请检查 logs/batond.log')
  }

  async request(
    request: ControlRequest,
    options: { readonly autostart?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<ControlResponse> {
    if (options.autostart !== false) await this.ensureDaemon()
    return this.send(request, options.timeoutMs ?? 30000)
  }

  status(): Promise<ControlResponse> {
    return this.request({ method: 'status' })
  }
  shutdown(): Promise<ControlResponse> {
    return this.request({ method: 'shutdown' }, { autostart: false })
  }
}

export const ensureDaemon = (dataDirectory: string, options?: ControlClientOptions): Promise<void> =>
  new ControlClient(dataDirectory, options).ensureDaemon()
