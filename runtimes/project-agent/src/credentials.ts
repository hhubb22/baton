import { promises as fs, constants } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { randomUUID } from 'node:crypto'

function native(operation: string, directory: string, file?: string, input?: string): string | undefined {
  const adjacent = fileURLToPath(new URL('../../../../../batond.exe', import.meta.url))
  const host = process.env.BATON_SIDECAR_HOST ?? (existsSync(adjacent) ? adjacent : 'batond')
  const result = spawnSync(host, ['sidecar-file', operation, directory, ...(file ? [file] : [])], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 500,
    maxBuffer: 64 * 1024,
  })
  if (result.status === 3 && operation === 'read') return undefined
  if (result.status !== 0) throw new Error('credential_private_file_failed')
  return result.stdout
}

export async function protect(path: string, directory: boolean): Promise<void> {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error('credential_path_invalid')
  if (process.platform === 'win32') {
    if (!directory) throw new Error('credential_use_native_write')
    native('protect-dir', path)
  } else {
    if (stat.uid !== process.getuid?.()) throw new Error('credential_owner_invalid')
    await fs.chmod(path, directory ? 0o700 : 0o600)
  }
}

// 锁覆盖整个 OAuth 刷新事务；心跳维护锁，崩溃遗留锁在 120 秒后回收。
export class FileCredentials {
  constructor(readonly directory: string) {}
  private file(provider: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new Error('credential_provider_invalid')
    return join(this.directory, `${provider}.json`)
  }
  async read(provider: string): Promise<any> {
    const path = this.file(provider)
    try {
      if (process.platform === 'win32') {
        const raw = native('read', this.directory, path)
        return raw === undefined ? undefined : JSON.parse(raw)
      }
      for (const [target, directory] of [
        [this.directory, true],
        [path, false],
      ] as const) {
        const stat = await fs.lstat(target)
        if (
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (directory ? !stat.isDirectory() : !stat.isFile()) ||
          stat.mode & 0o077
        )
          throw new Error('credential_permissions_invalid')
      }
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536)
          throw new Error('credential_permissions_invalid')
        return JSON.parse(await handle.readFile('utf8'))
      } finally {
        await handle.close()
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }
  async list(): Promise<{ providerId: string; type: 'oauth' | 'api_key' }[]> {
    let files: string[]
    try {
      files = await fs.readdir(this.directory)
    } catch (error: any) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const result = []
    for (const file of files.filter((f) => /^[a-z0-9-]+\.json$/.test(f)).sort()) {
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
        if (process.platform === 'win32') {
          native('write', this.directory, this.file(provider), JSON.stringify(next))
          return next
        }
        const temp = join(this.directory, `.credential-${randomUUID()}`)
        try {
          const handle = await fs.open(temp, 'wx', 0o600)
          try {
            await protect(temp, false)
            await handle.writeFile(JSON.stringify(next))
            await handle.sync()
          } finally {
            await handle.close()
          }
          await fs.rename(temp, this.file(provider))
        } finally {
          await fs.rm(temp, { force: true })
        }
        return next
      },
      options,
    )
  }
  async delete(provider: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.locked(provider, () => fs.rm(this.file(provider), { force: true }), options)
  }
}
