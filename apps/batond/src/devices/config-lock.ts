import { join, resolve } from 'node:path'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'

const queues = new Map<string, Promise<unknown>>()
export async function withConfigurationLock<A>(
  dataDirectory: string,
  name: string,
  action: () => Promise<A>,
): Promise<A> {
  const key = join(resolve(dataDirectory), `${name}.lock`)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ensurePrivateDirectory(dataDirectory)
      const release = await acquireProcessLock(key)
      try {
        return await action()
      } finally {
        await release()
      }
    })
  queues.set(key, next)
  try {
    return await next
  } finally {
    if (queues.get(key) === next) queues.delete(key)
  }
}
