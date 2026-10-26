import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { isSea } from 'node:sea'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import type { WorkerIPCMessage, WorkerRequest } from '@baton/protocol'
import {
  ensurePrivateDirectory,
  openPrivateFile,
  readPrivateFile,
  writePrivateFileAtomic,
} from '../platform/private.ts'
import { acquireProcessLock, processLockIsHeld, ProcessLockBusy } from '../platform/lock.ts'
import { IPCError, requestWorker } from './ipc.ts'
import { workerPaths } from './paths.ts'
import { FullOutputStore } from '../worker/full-output.ts'

export interface DaemonWorkerHost {
  ensureWorker(threadId: string): Promise<void>
  request(
    threadId: string,
    request: WorkerRequest,
    options?: { readonly start?: boolean; readonly timeoutMs?: number },
  ): Promise<WorkerIPCMessage>
}

/** 包住进程启动、锁获取、账本恢复与已认证 IPC。Windows 上新进程首次读取自身创建时间要启动 PowerShell，3 秒不够。 */
export const WORKER_READY_BUDGET_MS = process.platform === 'win32' ? 10000 : 3000

export interface BatondCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}

export function currentBatondCommand(): BatondCommand {
  return isSea()
    ? { executable: process.execPath, args: [] }
    : { executable: process.execPath, args: [resolve(process.argv[1]!)] }
}

export async function initializeWorkerDirectory(dataDirectory: string, threadId: string) {
  const paths = workerPaths(dataDirectory, threadId)
  await ensurePrivateDirectory(paths.root)
  await ensurePrivateDirectory(`${paths.root}/threads`)
  await ensurePrivateDirectory(paths.threadDirectory)
  await ensurePrivateDirectory(paths.ipcDirectory)
  return paths
}

async function readToken(path: string): Promise<string> {
  const token = (await readPrivateFile(path)).toString('utf8')
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid Worker IPC token')
  return token
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export class LocalWorkerHost implements DaemonWorkerHost {
  constructor(
    readonly dataDirectory: string,
    readonly command: BatondCommand = currentBatondCommand(),
  ) {}

  async request(
    threadId: string,
    request: typeof WorkerRequest.Type,
    options: {
      readonly start?: boolean
      readonly timeoutMs?: number
    } = {},
  ): Promise<WorkerIPCMessage> {
    const paths = workerPaths(this.dataDirectory, threadId)
    if (request.type === 'session_request' && request.session_request.action === 'full_output') {
      const body = request.session_request
      if (body.session_id !== threadId) return { type: 'result', ok: false, code: 'invalid_request' }
      const result = await new FullOutputStore(paths.threadDirectory).read(body)
      return { type: 'result', ok: result.ok, session_result: result }
    }
    if (options.start) await this.ensureWorker(threadId)
    return requestWorker({
      endpoint: paths.endpoint,
      token: await readToken(paths.token),
      request,
      timeoutMs: options.timeoutMs ?? 1000,
    })
  }

  /** Includes process startup, lock acquisition, ledger recovery scheduling and authenticated IPC. */
  async ensureWorker(threadId: string): Promise<void> {
    const deadline = performance.now() + WORKER_READY_BUDGET_MS
    const paths = await initializeWorkerDirectory(this.dataDirectory, threadId)
    const ready = async () => {
      try {
        const token = await readToken(paths.token)
        const status = await requestWorker({
          endpoint: paths.endpoint,
          token,
          request: { type: 'status', ok: false },
          timeoutMs: Math.max(1, Math.min(100, deadline - performance.now())),
        })
        return status.ok && status.worker_ready === true
      } catch (error) {
        if (error instanceof IPCError && error.code !== 'unauthorized') return false
        if (isMissing(error)) return false
        throw error
      }
    }
    if (await ready()) return
    let started = false
    while (performance.now() < deadline) {
      let release: (() => Promise<void>) | undefined
      try {
        release = await acquireProcessLock(paths.launchLock)
        if (await ready()) return
        if (!(await processLockIsHeld(paths.lock))) {
          try {
            await readToken(paths.token)
          } catch (error) {
            if (!isMissing(error)) throw error
            await writePrivateFileAtomic(paths.token, randomBytes(32).toString('hex'))
          }
          // A live Worker owns the endpoint. Only reclaim it after checking the process lock.
          if (process.platform !== 'win32')
            await unlink(paths.endpoint).catch((error: unknown) => {
              if (!isMissing(error)) throw error
            })
          try {
            const existingLog = await openPrivateFile(paths.log)
            await existingLog.close()
          } catch (error) {
            if (!isMissing(error)) throw error
            await writePrivateFileAtomic(paths.log, '')
          }
          const log = await openPrivateFile(paths.log, constants.O_WRONLY | constants.O_APPEND)
          try {
            const child = spawn(
              this.command.executable,
              [...this.command.args, 'worker', '--data-dir', paths.root, '--thread-id', threadId],
              { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true },
            )
            child.on('error', () => undefined)
            child.unref()
            started = true
          } finally {
            await log.close()
          }
        }
        // Keep the launch lock until the child publishes its own lock or authenticated IPC.
        while (performance.now() < deadline) {
          if (await ready()) return
          if (!started && !(await processLockIsHeld(paths.lock))) break
          await delay(20)
        }
      } catch (error) {
        if (!(error instanceof ProcessLockBusy)) throw error
      } finally {
        await release?.()
      }
      if (await ready()) return
      await delay(20)
    }
    throw new IPCError('worker_not_ready', `Worker did not become ready within ${WORKER_READY_BUDGET_MS} ms`)
  }
}
