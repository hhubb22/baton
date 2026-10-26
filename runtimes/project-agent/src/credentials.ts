import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { directCredentialFiles } from './credential-files.js'

const files = () => directCredentialFiles

export async function protect(path: string, directory: boolean): Promise<void> {
  await files().protect(path, directory)
}

// 锁覆盖整个 OAuth 刷新事务；心跳维护锁，崩溃遗留锁在 120 秒后回收。
export class FileCredentials {
  constructor(readonly directory: string) {}
  private file(provider: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new Error('credential_provider_invalid')
    return join(this.directory, `${provider}.json`)
  }
  async read(provider: string): Promise<any> {
    const raw = await files().read(this.file(provider))
    return raw === undefined ? undefined : JSON.parse(raw)
  }
  async list(): Promise<{ providerId: string; type: 'oauth' | 'api_key' }[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch (error: any) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const result = []
    for (const file of entries.filter((f) => /^[a-z0-9-]+\.json$/.test(f)).sort()) {
      const providerId = file.slice(0, -5),
        value = await this.read(providerId)
      if (value?.type === 'oauth' || value?.type === 'api_key') result.push({ providerId, type: value.type })
    }
    return result
  }
  private async locked<T>(provider: string, fn: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
    options?.signal?.throwIfAborted()
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await protect(this.directory, true)
    const release = await lockfile.lock(this.file(provider), {
      realpath: false,
      stale: 120_000,
      update: 10_000,
      retries: { retries: 2400, minTimeout: 50, maxTimeout: 50 },
    })
    try {
      options?.signal?.throwIfAborted()
      return await fn()
    } finally {
      await release()
    }
  }
  async modify(provider: string, fn: (current: any) => Promise<any>, options?: { signal?: AbortSignal }): Promise<any> {
    return this.locked(
      provider,
      async () => {
        const current = await this.read(provider),
          next = await fn(current)
        if (next === undefined) return current
        await files().write(this.file(provider), JSON.stringify(next))
        return next
      },
      options,
    )
  }
  async delete(provider: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.locked(provider, () => fs.rm(this.file(provider), { force: true }), options)
  }
}
