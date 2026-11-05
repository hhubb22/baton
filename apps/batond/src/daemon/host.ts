import { isSea } from 'node:sea'
import { resolve } from 'node:path'
import type { WorkerIPCMessage, WorkerRequest } from '@baton/protocol'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { workerPaths } from './paths.ts'

export interface DaemonWorkerHost {
  ensureWorker(threadId: string): Promise<void>
  request(
    threadId: string,
    request: WorkerRequest,
    options?: { readonly start?: boolean; readonly timeoutMs?: number },
  ): Promise<WorkerIPCMessage>
}

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
  return paths
}
