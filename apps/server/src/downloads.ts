import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { Schema } from 'effect'
import { DeploymentConfig } from '@baton/protocol/deployment'
import { ReleaseMetadata, releaseMetadata } from '@baton/protocol/release'
import type { DownloadItem, DownloadsResponse } from '@baton/protocol/http-api'

export interface DownloadsOptions {
  readonly directory: string
  readonly caFile?: string
  readonly cacheDirectory?: string
}

export function downloadsConfiguration(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.BATON_DOWNLOADS_DIR
    ? {
        directory: env.BATON_DOWNLOADS_DIR,
        ...(env.BATON_PUBLIC_CA_FILE ? { caFile: env.BATON_PUBLIC_CA_FILE } : {}),
        cacheDirectory: env.BATON_DOWNLOADS_CACHE || resolve('downloads-cache'),
      }
    : undefined
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const hashFile = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const stringAt = (header: Buffer, offset: number, size: number) =>
  header
    .subarray(offset, offset + size)
    .toString('utf8')
    .split('\0')[0]
const octalAt = (header: Buffer, offset: number, size: number) => {
  const value = stringAt(header, offset, size).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('tar 数值字段无效')
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) throw new Error('tar 数值超出范围')
  return number
}
const putOctal = (header: Buffer, offset: number, size: number, value: number) =>
  header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size, 'ascii')

function deploymentHeader(name: string, size: number, mtime: number) {
  const header = Buffer.alloc(512)
  if (Buffer.byteLength(name) > 100) throw new Error('部署配置路径过长')
  header.write(name)
  putOctal(header, 100, 8, 0o644)
  putOctal(header, 108, 8, 0)
  putOctal(header, 116, 8, 0)
  putOctal(header, 124, 12, size)
  putOctal(header, 136, 12, mtime)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

// PAX 记录按字节长度分隔；只读取 path，其余属性及原始记录保持不变。
function paxPath(content: Buffer): string | undefined {
  let path: string | undefined
  for (let offset = 0; offset < content.length;) {
    const space = content.indexOf(32, offset)
    const length = Number(content.subarray(offset, space).toString('ascii'))
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > content.length
    )
      throw new Error('PAX 记录长度无效')
    const record = content.subarray(space + 1, offset + length - 1)
    if (record.subarray(0, 5).toString('ascii') === 'path=') path = record.subarray(5).toString('utf8')
    offset += length
  }
  return path
}

// 普通文件分段透传，仅为文件名扩展头及 release.json 缓冲内容。
// 原有条目的头、内容和填充字节全部保持不变。
async function* injectTar(
  source: AsyncIterable<Buffer>,
  root: string,
  expected: DownloadItem,
  config: DeploymentConfig,
) {
  const iterator = source[Symbol.asyncIterator]()
  let pending: Buffer = Buffer.alloc(0)
  const take = async (size: number) => {
    const chunks: Buffer[] = []
    let remaining = size
    while (remaining) {
      if (!pending.length) {
        const next = await iterator.next()
        if (next.done) throw new Error('tar 归档提前结束')
        pending = next.value
      }
      const length = Math.min(remaining, pending.length)
      chunks.push(pending.subarray(0, length))
      pending = pending.subarray(length)
      remaining -= length
    }
    return Buffer.concat(chunks, size)
  }
  let releaseMtime: number | undefined
  let globalPath: string | undefined
  let localPath: string | undefined
  let longName: string | undefined
  while (true) {
    const header = await take(512)
    if (header.every((byte) => byte === 0)) {
      if (!(await take(512)).every((byte) => byte === 0)) throw new Error('tar 结束块无效')
      // 继续读到 gzip 尾部，让 zlib 核验原归档的 CRC。
      if (!pending.every((byte) => byte === 0)) throw new Error('tar 结束块之后有内容')
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
        if (!chunk.every((byte) => byte === 0)) throw new Error('tar 结束块之后有内容')
      }
      break
    }
    if (!['ustar', 'ustar '].includes(stringAt(header, 257, 6))) throw new Error('归档需要 ustar 文件头')
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== octalAt(header, 148, 8)) throw new Error('tar 文件头校验失败')
    const type = String.fromCharCode(header[156])
    const extension = ['x', 'g', 'L', 'K'].includes(type)
    const readExtension = extension && type !== 'K'
    const prefix = stringAt(header, 257, 6) === 'ustar ' ? '' : stringAt(header, 345, 155)
    const rawName = [prefix, stringAt(header, 0, 100)].filter(Boolean).join('/')
    const name = (localPath ?? globalPath ?? longName ?? rawName).replace(/\/$/, '')
    if (!extension) {
      localPath = undefined
      longName = undefined
      const appleDouble = name.split('/').some((part) => part.startsWith('._'))
      if (
        !appleDouble &&
        ((name !== root && !name.startsWith(root + '/')) ||
          name.split('/').some((part) => part === '..' || part === '.'))
      )
        throw new Error('tar 顶层目录不符')
      if (!appleDouble && name === `${root}/deployment.json`) throw new Error('通用归档中已存在部署配置')
    }
    const size = octalAt(header, 124, 12)
    if (readExtension && size > 1024 * 1024) throw new Error('tar 文件名扩展头过大')
    const isRelease = !extension && name === `${root}/release.json`
    if (isRelease && (releaseMtime !== undefined || ![0, 48].includes(header[156]) || size > 64 * 1024))
      throw new Error('release.json 无效')
    yield header
    let remaining = Math.ceil(size / 512) * 512
    const content: Buffer[] = []
    while (remaining) {
      const chunk = await take(Math.min(remaining, 64 * 1024))
      if (isRelease || readExtension) content.push(chunk)
      yield chunk
      remaining -= chunk.length
    }
    if (readExtension) {
      const value = Buffer.concat(content).subarray(0, size)
      if (type === 'L') longName = value.toString('utf8').split('\0')[0]
      else {
        const path = paxPath(value)
        if (type === 'g' && path !== undefined) globalPath = path || undefined
        if (type === 'x' && path !== undefined) localPath = path || undefined
      }
    }
    if (isRelease) {
      const metadata = Schema.decodeUnknownSync(ReleaseMetadata)(
        JSON.parse(Buffer.concat(content).subarray(0, size).toString()),
      )
      if (
        metadata.version !== root.slice(6, -`-${expected.platform}-${expected.arch}`.length) ||
        metadata.platform !== expected.platform ||
        metadata.arch !== expected.arch
      )
        throw new Error('release.json 版本或平台不符')
      releaseMtime = octalAt(header, 136, 12)
    }
  }
  if (releaseMtime === undefined) throw new Error('归档缺少 release.json')
  const deployment = Buffer.from(JSON.stringify(Schema.decodeUnknownSync(DeploymentConfig)(config)) + '\n')
  yield deploymentHeader(`${root}/deployment.json`, deployment.length, releaseMtime)
  yield deployment
  yield Buffer.alloc(((512 - (deployment.length % 512)) % 512) + 1024)
}

export async function injectDeployment(
  source: string,
  destination: string,
  item: DownloadItem,
  config: DeploymentConfig,
  signal?: AbortSignal,
) {
  await pipeline(
    createReadStream(source),
    createGunzip(),
    (input) => injectTar(input, item.file.slice(0, -7), item, config),
    createGzip({ level: 9 }),
    createWriteStream(destination, { mode: 0o600, flags: 'wx' }),
    { signal },
  )
}

interface Asset {
  readonly item: DownloadItem
  readonly path: string
}
export type Downloads = Awaited<ReturnType<typeof createDownloads>>
export const disabledDownloads = (): DownloadsResponse => ({
  enabled: false,
  version: releaseMetadata().version,
  connect_url: null,
  ca_sha256: null,
  items: [],
})

export async function createDownloads(
  options: DownloadsOptions,
  allowedOrigins: ReadonlyArray<string>,
  release: ReleaseMetadata = releaseMetadata(),
  log: (entry: { event: string; file?: string; reason: string }) => void = (entry) =>
    console.warn(JSON.stringify(entry)),
  inject: typeof injectDeployment = injectDeployment,
) {
  const cache = resolve(options.cacheDirectory ?? 'downloads-cache')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  await chmod(cache, 0o700)
  const ca = options.caFile ? new X509Certificate(await readFile(options.caFile)) : undefined
  if (ca && !ca.ca) throw new Error('BATON_PUBLIC_CA_FILE 需要 CA 证书')
  const origins = allowedOrigins.filter((origin) => Schema.is(DeploymentConfig)({ format: 1, coordinator_url: origin }))
  const configs = new Map(
    origins.map((origin) => [
      origin,
      {
        format: 1 as const,
        coordinator_url: origin,
        ...(ca ? { ca_pem: ca.toString() } : {}),
      },
    ]),
  )
  const controller = new AbortController()
  let assets = new Map<string, Asset>()
  let queue = Promise.resolve()
  const scheduled = new Set<string>()
  const generated = new Map<string, Asset>()
  const hashes = new Map<string, { signature: string; hash: string }>()
  const rejected = new Map<string, string>()
  const report = (file: string, reason: string) => {
    if (rejected.get(file) === reason) return
    rejected.set(file, reason)
    log({ event: 'download_rejected', file, reason })
  }
  const keyFor = (asset: Asset, origin: string) => `${asset.item.sha256}-${sha256(JSON.stringify(configs.get(origin)))}`
  const generate = (asset: Asset, origin: string) => {
    const key = keyFor(asset, origin)
    if (scheduled.has(key) || generated.has(key)) return
    scheduled.add(key)
    queue = queue.then(async () => {
      if (controller.signal.aborted) return
      const destination = join(cache, `${key}.tar.gz`)
      const temporary = `${destination}.${randomUUID()}.tmp`
      try {
        let hash: string
        try {
          const checksum = (await readFile(destination + '.sha256', 'utf8')).trim()
          hash = await hashFile(destination)
          if (hash !== checksum) throw new Error('缓存校验失败')
        } catch {
          await inject(asset.path, temporary, asset.item, configs.get(origin)!, controller.signal)
          if ((await hashFile(asset.path)) !== asset.item.sha256) throw new Error('注入期间源文件已变化')
          hash = await hashFile(temporary)
          await writeFile(temporary + '.sha256', hash + '\n', { mode: 0o600 })
          await rename(temporary + '.sha256', destination + '.sha256')
          await rename(temporary, destination)
        }
        generated.set(key, {
          path: destination,
          item: { ...asset.item, sha256: hash, size: (await stat(destination)).size },
        })
      } catch (error) {
        if (!controller.signal.aborted) report(asset.item.file, String(error))
      } finally {
        scheduled.delete(key)
        await Promise.allSettled([rm(temporary, { force: true }), rm(temporary + '.sha256', { force: true })])
      }
    })
  }
  let scanning: Promise<void> | undefined
  const scan = () => {
    if (scanning) return scanning
    scanning = (async () => {
      const next = new Map<string, Asset>()
      try {
        // 每次读取目录和文件属性；size/mtime 不变的归档复用哈希，也能发现原地替换。
        for (const file of (await readdir(options.directory)).sort()) {
          const match =
            /^(baton-desktop|baton)-([A-Za-z0-9][A-Za-z0-9.+-]*)-(darwin-arm64|linux-x64|linux-arm64|win32-x64)\.(tar\.gz|dmg|exe)$/.exec(
              file,
            )
          if (!match) continue
          const [, product, version, target, extension] = match
          const cli = product === 'baton'
          if (
            cli
              ? extension !== 'tar.gz' || target === 'win32-x64'
              : !((target === 'darwin-arm64' && extension === 'dmg') || (target === 'win32-x64' && extension === 'exe'))
          )
            continue
          try {
            if (!release.supported_daemon_versions.includes(version)) throw new Error('中心不接受该版本')
            const path = join(options.directory, file)
            const info = await lstat(path)
            if (!info.isFile()) throw new Error('安装包需要普通文件')
            const checksum = (await readFile(path + '.sha256', 'utf8')).trim().split(/\s+/)[0]
            if (!/^[a-fA-F0-9]{64}$/.test(checksum)) throw new Error('sha256 文件无效')
            const signature = `${info.size}:${info.mtimeMs}`
            let hash = hashes.get(file)
            if (hash?.signature !== signature) {
              hash = { signature, hash: await hashFile(path) }
              hashes.set(file, hash)
            }
            if (hash.hash !== checksum.toLowerCase()) throw new Error('安装包 SHA-256 不符')
            const [platform, arch] = target.split('-') as [DownloadItem['platform'], DownloadItem['arch']]
            const asset = {
              path,
              item: {
                kind: cli ? ('cli' as const) : ('desktop' as const),
                platform,
                arch,
                file,
                size: info.size,
                sha256: hash.hash,
              },
            }
            next.set(file, asset)
            if (cli) for (const origin of configs.keys()) generate(asset, origin)
          } catch (error) {
            report(file, String(error))
          }
        }
      } catch (error) {
        report(options.directory, String(error))
      }
      assets = next
    })().finally(() => {
      scanning = undefined
    })
    return scanning
  }
  await scan()
  let hostReported = false
  const originFor = (host: string) =>
    origins.find((origin) => new URL(origin).host.toLowerCase() === host.toLowerCase())
  const list = async (host: string): Promise<DownloadsResponse> => {
    await scan()
    const origin = originFor(host)
    if (!origin && !hostReported) {
      hostReported = true
      log({ event: 'download_host_unmatched', reason: '请求 Host 未匹配 BATON_ALLOWED_ORIGINS' })
    }
    const items = [...assets.values()].flatMap((asset) => {
      if (asset.item.kind === 'desktop') return [asset.item]
      const output = origin ? generated.get(keyFor(asset, origin)) : undefined
      return output ? [output.item] : []
    })
    return {
      enabled: true,
      version: release.version,
      connect_url: origin
        ? `baton://connect?url=${encodeURIComponent(origin)}${ca ? `&ca=${ca.raw.toString('base64url')}` : ''}`
        : null,
      ca_sha256: ca ? sha256(ca.raw) : null,
      items,
    }
  }
  return {
    list,
    file: async (host: string, file: string) => {
      const listing = await list(host)
      const item = listing.items.find((item) => item.file === file)
      if (!item) return undefined
      const asset = assets.get(file)!
      return item.kind === 'desktop' ? asset : generated.get(keyFor(asset, originFor(host)!))
    },
    close: async () => {
      controller.abort()
      await scanning
      await queue
    },
  }
}
