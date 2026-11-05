import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { DeploymentConfig } from '@baton/protocol/deployment'
import { releaseMetadata, type ReleaseMetadata } from '@baton/protocol/release'
import type { DownloadItem, DownloadsResponse } from '@baton/protocol/http-api'

export interface DownloadsOptions {
  readonly directory: string
}

export function downloadsConfiguration(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.BATON_DOWNLOADS_DIR ? { directory: env.BATON_DOWNLOADS_DIR } : undefined
}

export const disabledDownloads = (): DownloadsResponse => ({
  enabled: false,
  version: releaseMetadata().version,
  connect_url: null,
  items: [],
})

export type Downloads = Awaited<ReturnType<typeof createDownloads>>

export async function createDownloads(
  options: DownloadsOptions,
  allowedOrigins: ReadonlyArray<string>,
  release: ReleaseMetadata = releaseMetadata(),
  log: (entry: { event: string; file?: string; reason: string }) => void = (entry) =>
    console.warn(JSON.stringify(entry)),
) {
  const origins = allowedOrigins.filter((origin) => Schema.is(DeploymentConfig)({ format: 1, coordinator_url: origin }))
  const rejected = new Map<string, string>()
  const cache = new Map<string, { identity: string; sha256: string }>()
  const scan = async () => {
    const assets = new Map<string, { item: DownloadItem; path: string }>()
    let files: string[]
    try {
      files = await readdir(options.directory)
    } catch {
      return assets
    }
    for (const file of files.sort()) {
      const match =
        /^(baton-desktop|baton)-([A-Za-z0-9][A-Za-z0-9.+-]*)-(darwin-arm64|linux-x64|linux-arm64|win32-x64|win-x64)\.(tar\.gz|zip|dmg|exe)$/.exec(
          file,
        )
      if (!match) continue
      const [, product, version, target, extension] = match
      const cli = product === 'baton'
      if (
        version !== release.version ||
        (cli
          ? !(['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target!) && extension === 'tar.gz')
          : !((target === 'darwin-arm64' && extension === 'dmg') || (target === 'win32-x64' && extension === 'exe')))
      )
        continue
      try {
        const path = join(options.directory, file)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('安装包需要普通文件')
        const checksum = (await readFile(path + '.sha256', 'utf8')).trim().split(/\s+/)[0]?.toLowerCase()
        if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('安装包摘要无效')
        const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        let hash = cache.get(file)
        if (hash?.identity !== identity) {
          const digest = createHash('sha256')
          for await (const chunk of createReadStream(path)) digest.update(chunk)
          hash = { identity, sha256: digest.digest('hex') }
          cache.set(file, hash)
        }
        if (hash.sha256 !== checksum) throw new Error('安装包摘要不符')
        const [system, arch] = target!.split('-')
        const platform = system === 'win' ? 'win32' : system
        const item = {
          kind: cli ? 'cli' : 'desktop',
          platform,
          arch,
          file,
          size: info.size,
          sha256: hash.sha256,
        } as DownloadItem
        assets.set(file, { item, path })
        rejected.delete(file)
      } catch (error) {
        const reason = error instanceof Error ? error.message : '安装包不可用'
        if (rejected.get(file) !== reason) log({ event: 'download_rejected', file, reason })
        rejected.set(file, reason)
      }
    }
    return assets
  }
  const originFor = (host: string) =>
    origins.find((origin) => new URL(origin).host.toLowerCase() === host.toLowerCase())
  return {
    list: async (host: string): Promise<DownloadsResponse> => {
      const origin = originFor(host)
      const assets = await scan()
      return {
        enabled: true,
        version: release.version,
        connect_url: origin ? `baton://connect?url=${encodeURIComponent(origin)}` : null,
        items: [...assets.values()].map((asset) => asset.item),
      }
    },
    file: async (_host: string, file: string) => (await scan()).get(file),
    close: async () => {},
  }
}
