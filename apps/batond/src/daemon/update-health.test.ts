import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { expect, it } from 'vite-plus/test'
import { acquireProcessLock } from '../platform/lock.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { waitLocalStartup } from './update-orchestrator.ts'

it('accepts a live target identity even while it is offline, and fails when no process starts', async () => {
  const directory = await makePrivateTempDirectory('baton-update-health-')
  try {
    await expect(waitLocalStartup(directory, 'v1.2.3', false, { timeoutMs: 10, pollMs: 2 })).rejects.toThrow(
      '目标 daemon 未能启动',
    )
    const lock = await acquireProcessLock(join(directory, 'daemon.lock'))
    try {
      await expect(waitLocalStartup(directory, 'v1.2.3', false, { timeoutMs: 10, pollMs: 2 })).rejects.toThrow(
        '目标 daemon 本地身份或状态不匹配',
      )
      await writePrivateFileAtomic(
        join(directory, 'daemon-status.json'),
        JSON.stringify({
          pid: lock.record.pid,
          creation_time: lock.record.creationTime,
          batond_version: 'v1.2.3',
          state: 'connecting',
        }),
      )
      await expect(waitLocalStartup(directory, 'v1.2.3', false, { timeoutMs: 10, pollMs: 2 })).resolves.toBeUndefined()
    } finally {
      await lock()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
