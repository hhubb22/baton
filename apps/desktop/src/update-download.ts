import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { DeploymentConfig } from '@baton/protocol/deployment'
import { DownloadItem, DownloadsResponse } from '@baton/protocol/http-api'
import { ReleaseMetadata } from '@baton/protocol/release'
import { Schema } from 'effect'

export type UpdateCheckResult =
  | { readonly status: 'available'; readonly release: ReleaseMetadata; readonly item: DownloadItem }
  | { readonly status: 'current'; readonly release: ReleaseMetadata }
  | {
      readonly status: 'unavailable'
      readonly release: ReleaseMetadata
      readonly reason: 'unsupported-platform' | 'downloads-disabled' | 'release-changed' | 'package-missing'
    }

export interface UpdateDownloadOptions {
  readonly request?: typeof httpsRequest
  readonly metadataTimeoutMs?: number
  readonly downloadTimeoutMs?: number
  readonly maxMetadataBytes?: number
  readonly maxDownloadBytes?: number
}

export type UpdateDownloadErrorCode =
  | 'invalid-config'
  | 'invalid-metadata'
  | 'http'
  | 'timeout'
  | 'limit'
  | 'network'
  | 'integrity'
  | 'unsafe-file'
  | 'io'

export class UpdateDownloadError extends Error {
  constructor(
    readonly code: UpdateDownloadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'UpdateDownloadError'
  }
}

const decodeConfig = Schema.decodeUnknownSync(DeploymentConfig)
const decodeRelease = Schema.decodeUnknownSync(ReleaseMetadata)
const decodeDownloads = Schema.decodeUnknownSync(DownloadsResponse)
const decodeItem = Schema.decodeUnknownSync(DownloadItem)
const pending = new Map<string, Promise<string>>()

function failure(code: UpdateDownloadErrorCode, message: string): UpdateDownloadError {
  return new UpdateDownloadError(code, message)
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function discard(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!missing(error)) throw error
  })
}

function configFor(input: DeploymentConfig): DeploymentConfig {
  try {
    return decodeConfig(input)
  } catch {
    throw failure('invalid-config', '更新来源必须是已保存的 HTTPS 中心')
  }
}

function filename(version: string, platform: string, arch: string): string | undefined {
  if (version.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version))
    throw failure('invalid-metadata', '中心版本不能构成标准安装包文件名')
  const extension =
    platform === 'darwin' && arch === 'arm64' ? 'dmg' : platform === 'win32' && arch === 'x64' ? 'exe' : undefined
  return extension ? `baton-desktop-${version}-${platform}-${arch}.${extension}` : undefined
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe-file', '更新缓存必须是普通目录')
  await chmod(path, 0o700)
}

/** 仅供 main 调用；item 和安装路径不得由网页直接提供。 */
export class UpdateDownloader {
  readonly #request: typeof httpsRequest
  readonly #metadataTimeoutMs: number
  readonly #downloadTimeoutMs: number
  readonly #maxMetadataBytes: number
  readonly #maxDownloadBytes: number

  constructor(options: UpdateDownloadOptions = {}) {
    this.#request = options.request ?? httpsRequest
    this.#metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? 30 * 60_000
    this.#maxMetadataBytes = options.maxMetadataBytes ?? 1024 * 1024
    this.#maxDownloadBytes = options.maxDownloadBytes ?? 2 * 1024 * 1024 * 1024
    for (const value of [
      this.#metadataTimeoutMs,
      this.#downloadTimeoutMs,
      this.#maxMetadataBytes,
      this.#maxDownloadBytes,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('更新资源限制必须是正整数')
    }
  }

  async check(
    config: DeploymentConfig,
    currentVersion: string,
    platform: string = process.platform,
    arch: string = process.arch,
  ): Promise<UpdateCheckResult> {
    const saved = configFor(config)
    const release = await this.#json(saved, '/api/v1/release', decodeRelease)
    if (release.version === currentVersion) return { status: 'current', release }
    const expected = filename(release.version, platform, arch)
    if (!expected) return { status: 'unavailable', release, reason: 'unsupported-platform' }
    const downloads = await this.#json(saved, '/api/v1/downloads', decodeDownloads)
    if (!downloads.enabled) return { status: 'unavailable', release, reason: 'downloads-disabled' }
    if (downloads.version !== release.version) return { status: 'unavailable', release, reason: 'release-changed' }
    const matches = downloads.items.filter(
      (item) => item.kind === 'desktop' && item.platform === platform && item.arch === arch && item.file === expected,
    )
    if (matches.length === 0) return { status: 'unavailable', release, reason: 'package-missing' }
    if (matches.length !== 1) throw failure('invalid-metadata', '中心返回了重复的安装包')
    return { status: 'available', release, item: this.#item(matches[0]!) }
  }

  async download(config: DeploymentConfig, item: DownloadItem, userData: string): Promise<string> {
    const saved = configFor(config)
    const valid = this.#item(item)
    // 摘要目录使不同中心或同名但内容不同的安装包不会复用错误缓存。
    const directory = join(userData, 'updates', valid.sha256.toLowerCase())
    const path = join(directory, valid.file)
    const active = pending.get(path)
    if (active) {
      await active
      return this.verify(valid, path)
    }
    const operation = this.#download(saved, valid, userData, directory, path)
    pending.set(path, operation)
    try {
      return await operation
    } catch (error) {
      if (error instanceof UpdateDownloadError) throw error
      throw new UpdateDownloadError('io', '无法保存更新安装包', { cause: error })
    } finally {
      pending.delete(path)
    }
  }

  /** 安装前必须再次调用；校验失败会删除文件并拒绝返回路径。 */
  async verify(item: DownloadItem, path: string): Promise<string> {
    const valid = this.#item(item)
    try {
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink()) throw failure('unsafe-file', '安装包必须是普通文件')
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const start = await handle.stat()
        if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev || start.nlink !== 1)
          throw failure('unsafe-file', '安装包文件已被替换或具有硬链接')
        if (start.size !== valid.size) throw failure('integrity', '安装包大小不符')
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          size += chunk.length
          if (size > valid.size) throw failure('integrity', '安装包大小不符')
          hash.update(chunk)
        }
        const end = await handle.stat()
        const current = await lstat(path)
        if (
          size !== valid.size ||
          hash.digest('hex') !== valid.sha256.toLowerCase() ||
          end.size !== start.size ||
          end.mtimeMs !== start.mtimeMs ||
          end.ctimeMs !== start.ctimeMs ||
          current.isSymbolicLink() ||
          current.ino !== start.ino ||
          current.dev !== start.dev
        )
          throw failure('integrity', '安装包 SHA-256 不符或校验期间文件发生变化')
      } finally {
        await handle.close()
      }
      return path
    } catch (error) {
      // 目录不做递归删除；符号链接只移除链接本身。
      const info = await lstat(path).catch((cause: unknown) => {
        if (!missing(cause)) throw cause
        return undefined
      })
      if (info && !info.isDirectory()) await discard(path)
      if (error instanceof UpdateDownloadError) throw error
      throw new UpdateDownloadError('io', '无法校验更新安装包', { cause: error })
    }
  }

  #item(input: DownloadItem): DownloadItem {
    let item: DownloadItem
    try {
      item = decodeItem(input)
    } catch {
      throw failure('invalid-metadata', '安装包信息无效')
    }
    const match = /^baton-desktop-([A-Za-z0-9][A-Za-z0-9.+-]*)-(darwin-arm64|win32-x64)\.(dmg|exe)$/.exec(item.file)
    if (
      item.kind !== 'desktop' ||
      !match ||
      filename(match[1]!, item.platform, item.arch) !== item.file ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      item.size > this.#maxDownloadBytes ||
      !/^[a-fA-F0-9]{64}$/.test(item.sha256)
    )
      throw failure('invalid-metadata', '安装包名称、大小或 SHA-256 无效')
    return item
  }

  async #download(
    config: DeploymentConfig,
    item: DownloadItem,
    userData: string,
    directory: string,
    path: string,
  ): Promise<string> {
    await privateDirectory(join(userData, 'updates'))
    await privateDirectory(directory)
    const temporary = path + '.part'
    await discard(temporary)
    try {
      await lstat(path)
      try {
        return await this.verify(item, path)
      } catch (error) {
        if (!(error instanceof UpdateDownloadError) || !['integrity', 'unsafe-file'].includes(error.code)) throw error
      }
    } catch (error) {
      if (!missing(error)) throw error
    }
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await this.#response(config, `/downloads/${item.file}`, item.size, this.#downloadTimeoutMs, async (body) => {
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of body) {
          size += chunk.length
          hash.update(chunk)
          await handle.writeFile(chunk)
        }
        if (size !== item.size || hash.digest('hex') !== item.sha256.toLowerCase())
          throw failure('integrity', '安装包大小或 SHA-256 不符')
      })
      await handle.sync()
    } catch (error) {
      await handle.close()
      await discard(temporary)
      throw error
    }
    await handle.close()
    try {
      await rename(temporary, path)
      return await this.verify(item, path)
    } finally {
      await discard(temporary)
    }
  }

  async #json<T>(config: DeploymentConfig, path: string, decode: (value: unknown) => T): Promise<T> {
    return this.#response(config, path, this.#maxMetadataBytes, this.#metadataTimeoutMs, async (body) => {
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(chunk)
      try {
        return decode(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        throw failure('invalid-metadata', '中心更新信息格式无效')
      }
    })
  }

  async #response<T>(
    config: DeploymentConfig,
    path: string,
    limit: number,
    timeout: number,
    consume: (body: AsyncIterable<Buffer>) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response: IncomingMessage | undefined
    let request: ClientRequest | undefined
    try {
      request = this.#request(new URL(path, config.coordinator_url), {
        method: 'GET',
        ca: config.ca_pem,
        rejectUnauthorized: true,
        agent: false,
        signal: controller.signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          Accept: path.startsWith('/api/') ? 'application/json' : 'application/octet-stream',
          'Accept-Encoding': 'identity',
        },
      })
      const outgoing = request
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        outgoing.once('response', resolve)
        outgoing.on('error', (error) => {
          response?.destroy(error)
          reject(error)
        })
        outgoing.end()
      })
      if (response.statusCode !== 200) throw failure('http', `更新请求失败（HTTP ${response.statusCode ?? 0}）`)
      const encoding = response.headers['content-encoding']
      if (encoding && encoding !== 'identity') throw failure('http', '更新响应不能使用内容压缩')
      const declared = response.headers['content-length']
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)
      )
        throw failure('limit', '更新响应超过大小限制')
      const source = response
      async function* bounded(): AsyncGenerator<Buffer> {
        let size = 0
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > limit) throw failure('limit', '更新响应超过大小限制')
          yield buffer
        }
        if (declared !== undefined && size !== Number(declared)) throw failure('integrity', '更新响应长度不符')
      }
      const result = await consume(bounded())
      if (controller.signal.aborted) throw failure('timeout', '更新请求超时，请重试')
      return result
    } catch (error) {
      if (controller.signal.aborted) throw failure('timeout', '更新请求超时，请重试')
      if (error instanceof UpdateDownloadError) throw error
      throw new UpdateDownloadError('network', '无法从已保存中心获取更新', { cause: error })
    } finally {
      clearTimeout(timer)
      response?.destroy()
      request?.destroy()
    }
  }
}
