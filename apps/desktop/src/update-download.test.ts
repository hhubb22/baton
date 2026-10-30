import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type ClientRequest, type IncomingMessage } from 'node:http'
import type { RequestOptions, request as httpsRequest } from 'node:https'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import type { DeploymentConfig } from '@baton/protocol/deployment'
import type { DownloadItem, DownloadsResponse } from '@baton/protocol/http-api'
import type { ReleaseMetadata } from '@baton/protocol/release'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { UpdateDownloader, type UpdateDownloadOptions } from './update-download.ts'

const config: DeploymentConfig = { format: 1, coordinator_url: 'https://center.test:8443', ca_pem: 'saved-ca' }
const payload = Buffer.from('offline installer payload')
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const release: ReleaseMetadata = {
  version: 'v2.0.0',
  commit: 'a'.repeat(40),
  platform: 'linux',
  arch: 'x64',
  protocol_version: 1,
  schema_version: '1',
  ledger_versions: { node: 1, project: 1, thread: 1, execution: 1 },
  supported_daemon_versions: ['v2.0.0', 'v1.0.0'],
}
const item: DownloadItem = {
  kind: 'desktop',
  platform: 'darwin',
  arch: 'arm64',
  file: 'baton-desktop-v2.0.0-darwin-arm64.dmg',
  size: payload.length,
  sha256: digest(payload),
}
const windowsItem: DownloadItem = {
  ...item,
  platform: 'win32',
  arch: 'x64',
  file: 'baton-desktop-v2.0.0-win32-x64.exe',
}
const listing = (items: readonly DownloadItem[] = [item, windowsItem]): DownloadsResponse => ({
  enabled: true,
  version: release.version,
  connect_url: null,
  ca_sha256: null,
  items,
})

interface Reply {
  readonly body?: string | Buffer
  readonly status?: number
  readonly headers?: IncomingMessage['headers']
  readonly hang?: 'headers' | 'body'
  readonly error?: Error
  readonly stream?: PassThrough
}
const json = (value: unknown): Reply => ({ body: JSON.stringify(value) })

// HTTPS request 替身只提供离线响应，保留 Node 响应流与 AbortSignal 的行为。
function offline(replies: Reply[], options: Omit<UpdateDownloadOptions, 'request'> = {}) {
  const calls: { url: URL; options: RequestOptions }[] = []
  let destroyed = 0
  const request = ((url: URL, requestOptions: RequestOptions) => {
    calls.push({ url, options: requestOptions })
    const reply = replies.shift()
    if (!reply) throw new Error('未提供离线响应')
    const source = reply.stream ?? new PassThrough()
    const response = Object.assign(source, { statusCode: reply.status ?? 200, headers: reply.headers ?? {} })
    const req = new EventEmitter()
    const abort = () => {
      const error = new Error('aborted')
      req.emit('error', error)
    }
    requestOptions.signal?.addEventListener('abort', abort, { once: true })
    return Object.assign(req, {
      end() {
        queueMicrotask(() => {
          if (reply.error) {
            req.emit('error', reply.error)
            return
          }
          if (reply.hang === 'headers') return
          req.emit('response', response)
          if (!reply.stream && reply.hang !== 'body') source.end(reply.body ?? '')
        })
      },
      destroy() {
        destroyed++
        requestOptions.signal?.removeEventListener('abort', abort)
        source.destroy()
      },
    }) as unknown as ClientRequest
  }) as typeof httpsRequest
  return { downloader: new UpdateDownloader({ ...options, request }), calls, destroyed: () => destroyed }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function userData(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'baton-update-download-'))
  directories.push(path)
  return path
}
const cache = (root: string, asset = item) => join(root, 'updates', asset.sha256.toLowerCase(), asset.file)

async function expectEmptyCache(root: string, asset = item): Promise<void> {
  expect(await readdir(join(root, 'updates', asset.sha256.toLowerCase()))).toEqual([])
}

describe('UpdateDownloader.check', () => {
  it.each(['v1.0.0', 'v3.0.0', 'development'])('任何不同版本 %s 都选择中心版本，包含降级', async (current) => {
    const { downloader, calls } = offline([json(release), json(listing())])
    expect(await downloader.check(config, current, 'darwin', 'arm64')).toEqual({ status: 'available', release, item })
    expect(calls.map(({ url }) => url.href)).toEqual([
      'https://center.test:8443/api/v1/release',
      'https://center.test:8443/api/v1/downloads',
    ])
    for (const call of calls) {
      expect(call.options.ca).toBe(config.ca_pem)
      expect(call.options.rejectUnauthorized).toBe(true)
      expect(call.options.agent).toBe(false)
    }
  })

  it('版本一致时返回 current，不查询安装包', async () => {
    const { downloader, calls } = offline([json(release)])
    expect(await downloader.check(config, release.version)).toEqual({ status: 'current', release })
    expect(calls).toHaveLength(1)
  })

  it('选择 Windows x64 的标准文件名，忽略响应中的 URL', async () => {
    const downloads = { ...listing(), items: [{ ...windowsItem, url: 'https://attacker.test/installer.exe' }] }
    const { downloader } = offline([json(release), json(downloads)])
    expect(await downloader.check(config, 'v1.0.0', 'win32', 'x64')).toEqual({
      status: 'available',
      release,
      item: windowsItem,
    })
  })

  it.each([
    { downloads: { ...listing(), enabled: false }, reason: 'downloads-disabled' },
    { downloads: { ...listing(), version: 'v3.0.0' }, reason: 'release-changed' },
    { downloads: listing([]), reason: 'package-missing' },
    { downloads: listing([{ ...item, file: 'baton-desktop-v1.0.0-darwin-arm64.dmg' }]), reason: 'package-missing' },
    { downloads: listing([{ ...item, kind: 'cli' }]), reason: 'package-missing' },
    { downloads: listing([{ ...item, platform: 'win32' }]), reason: 'package-missing' },
    { downloads: listing([{ ...item, arch: 'x64' }]), reason: 'package-missing' },
    { downloads: listing([{ ...item, file: '../' + item.file }]), reason: 'package-missing' },
    { downloads: listing([{ ...item, file: 'https://attacker.test/' + item.file }]), reason: 'package-missing' },
  ])('提供可重试的缺包原因 $reason', async ({ downloads, reason }) => {
    const { downloader } = offline([json(release), json(downloads)])
    expect(await downloader.check(config, 'v1.0.0', 'darwin', 'arm64')).toEqual({
      status: 'unavailable',
      release,
      reason,
    })
  })

  it('未支持的目标返回缺包信息', async () => {
    const { downloader } = offline([json(release)])
    expect(await downloader.check(config, 'v1.0.0', 'linux', 'x64')).toEqual({
      status: 'unavailable',
      release,
      reason: 'unsupported-platform',
    })
  })

  it.each([json({ ...release, version: '../v2' }), json({ ...release, ledger_versions: null }), { body: 'not JSON' }])(
    '拒绝无效 release',
    async (reply) => {
      const { downloader } = offline([reply])
      await expect(downloader.check(config, 'v1.0.0', 'darwin', 'arm64')).rejects.toMatchObject({
        code: 'invalid-metadata',
      })
    },
  )

  it('拒绝无效或重复的当前版本安装包元数据', async () => {
    for (const items of [[{ ...item, sha256: 'bad' }], [item, item], [{ ...item, size: 0 }]]) {
      const { downloader } = offline([json(release), json(listing(items))])
      await expect(downloader.check(config, 'v1.0.0', 'darwin', 'arm64')).rejects.toMatchObject({
        code: 'invalid-metadata',
      })
    }
    const { downloader } = offline([json(release), json({ items: [] })])
    await expect(downloader.check(config, 'v1.0.0', 'darwin', 'arm64')).rejects.toMatchObject({
      code: 'invalid-metadata',
    })
  })
})

describe('HTTPS 请求边界', () => {
  it.each([
    'http://center.test',
    'https://center.test/path',
    'https://user:pass@center.test',
    'https://center.test?token=secret',
    'https://center.test#fragment',
  ])('请求前拒绝不合法中心 %s', async (origin) => {
    const { downloader, calls } = offline([])
    const bad = { ...config, coordinator_url: origin }
    await expect(downloader.check(bad, 'v1')).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(downloader.download(bad, item, await userData())).rejects.toMatchObject({ code: 'invalid-config' })
    expect(calls).toEqual([])
  })

  it('没有保存 CA 时使用系统信任', async () => {
    const { downloader, calls } = offline([json(release)])
    await downloader.check({ format: 1, coordinator_url: config.coordinator_url }, release.version)
    expect(calls[0]!.options.ca).toBeUndefined()
    expect(calls[0]!.options.rejectUnauthorized).toBe(true)
  })

  it.each([301, 302, 303, 307, 308, 404, 500])('拒绝 HTTP %s，不跟随重定向', async (status) => {
    const { downloader, calls, destroyed } = offline([
      { status, headers: { location: 'https://attacker.test/release' } },
    ])
    await expect(downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'http' })
    expect(calls).toHaveLength(1)
    expect(destroyed()).toBe(1)
  })

  it.each([
    { body: 'x'.repeat(65) },
    { headers: { 'content-length': '65' } },
    { headers: { 'content-length': 'invalid' } },
  ])('限制声明长度和实际响应大小', async (reply) => {
    const { downloader } = offline([reply], { maxMetadataBytes: 64 })
    await expect(downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'limit' })
  })

  it('拒绝压缩和声明长度不符的响应', async () => {
    const compressed = offline([{ headers: { 'content-encoding': 'gzip' } }])
    await expect(compressed.downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'http' })
    const truncated = offline([{ body: 'x', headers: { 'content-length': '2' } }])
    await expect(truncated.downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'integrity' })
  })

  it.each(['headers', 'body'] as const)('总时间限制覆盖 %s 等待', async (hang) => {
    const { downloader, destroyed } = offline([{ hang }], { metadataTimeoutMs: 20 })
    await expect(downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'timeout' })
    expect(destroyed()).toBe(1)
  })

  it('网络失败提供错误码', async () => {
    const { downloader } = offline([{ error: new Error('TLS verification failed') }])
    await expect(downloader.check(config, 'v1')).rejects.toMatchObject({ code: 'network' })
  })

  it('真实 HTTPS 栈拒绝明文 HTTP 服务', async () => {
    const server = createServer((_request, response) => response.end(JSON.stringify(release)))
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('本地端口不可用')
      const downloader = new UpdateDownloader({ metadataTimeoutMs: 1000 })
      await expect(
        downloader.check({ format: 1, coordinator_url: `https://127.0.0.1:${address.port}` }, 'v1'),
      ).rejects.toMatchObject({ code: 'network' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})

describe('下载与重启重试', () => {
  it('流式写临时文件，完整校验后原子改名；目录和文件权限私有', async () => {
    const root = await userData()
    const stream = new PassThrough()
    const { downloader, calls } = offline([{ stream }])
    const operation = downloader.download(config, item, root)
    const path = cache(root)
    stream.write(payload.subarray(0, 5))
    for (let attempt = 0; attempt < 100; attempt++) {
      const size = await stat(path + '.part').then(
        (info) => info.size,
        () => 0,
      )
      if (size === 5) break
      await setImmediate()
    }
    expect(await readFile(path + '.part')).toEqual(payload.subarray(0, 5))
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    stream.end(payload.subarray(5))
    expect(await operation).toBe(path)
    expect(await readFile(path)).toEqual(payload)
    expect(calls[0]!.url.href).toBe(`${config.coordinator_url}/downloads/${item.file}`)
    expect(await readdir(join(root, 'updates', item.sha256))).toEqual([item.file])
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'updates'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, 'updates', item.sha256))).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(await downloader.verify(item, path)).toBe(path)
  })

  it('新实例重用完整缓存、删除重启遗留的临时文件并修正目录权限', async () => {
    const root = await userData()
    const first = offline([{ body: payload }])
    const path = await first.downloader.download(config, item, root)
    await writeFile(path + '.part', 'interrupted')
    await chmod(join(root, 'updates'), 0o755)
    const restarted = offline([])
    expect(await restarted.downloader.download(config, item, root)).toBe(path)
    expect(restarted.calls).toEqual([])
    await expect(lstat(path + '.part')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('缓存被篡改后删除并重新下载', async () => {
    const root = await userData()
    const { downloader, calls } = offline([{ body: payload }, { body: payload }])
    const path = await downloader.download(config, item, root)
    await writeFile(path, Buffer.alloc(payload.length, 0))
    expect(await downloader.download(config, item, root)).toBe(path)
    expect(calls).toHaveLength(2)
    expect(await readFile(path)).toEqual(payload)
  })

  it.each([
    { reply: { body: Buffer.alloc(payload.length, 0) }, code: 'integrity' },
    { reply: { body: payload.subarray(1) }, code: 'integrity' },
    { reply: { body: Buffer.concat([payload, Buffer.from('extra')]) }, code: 'limit' },
    { reply: { headers: { 'content-length': String(payload.length + 1) } }, code: 'limit' },
    { reply: { status: 302, headers: { location: '/other-file.dmg' } }, code: 'http' },
    { reply: { error: new Error('connection lost') }, code: 'network' },
    { reply: { hang: 'body' as const }, code: 'timeout' },
  ])('失败丢弃临时文件，可重新下载：$code', async ({ reply, code }) => {
    const root = await userData()
    const { downloader } = offline([reply, { body: payload }], { downloadTimeoutMs: 30 })
    await expect(downloader.download(config, item, root)).rejects.toMatchObject({ code })
    await expectEmptyCache(root)
    expect(await downloader.download(config, item, root)).toBe(cache(root))
  })

  it('响应流中断也清理临时文件', async () => {
    const root = await userData()
    const stream = new PassThrough()
    const { downloader, calls } = offline([{ stream }])
    const operation = downloader.download(config, item, root)
    const rejection = expect(operation).rejects.toMatchObject({ code: 'network' })
    while (calls.length === 0) await setImmediate()
    stream.write(payload.subarray(0, 5))
    await setImmediate()
    stream.destroy(new Error('connection reset'))
    await rejection
    await expectEmptyCache(root)
  })

  it('同一缓存目标并发下载只发出一次请求', async () => {
    const root = await userData()
    const { downloader, calls } = offline([{ body: payload }])
    const results = await Promise.all([
      downloader.download(config, item, root),
      downloader.download(config, item, root),
    ])
    expect(results).toEqual([cache(root), cache(root)])
    expect(calls).toHaveLength(1)
  })

  it.each([
    { ...item, file: '../escape.dmg' },
    { ...item, file: 'https://attacker.test/file.dmg' },
    { ...item, file: item.file + '?url=x' },
    { ...item, file: item.file.replace('darwin-arm64.dmg', 'win32-x64.dmg') },
    { ...item, file: item.file.replace('v2.0.0', 'v2%2f0') },
    { ...item, platform: 'linux' as const },
    { ...item, kind: 'cli' as const },
    { ...item, sha256: 'invalid' },
    { ...item, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...item, size: 0 },
    { ...item, size: 100 },
  ])('下载前拒绝非法 item：$file / $size', async (bad) => {
    const root = await userData()
    const { downloader, calls } = offline([], { maxDownloadBytes: 50 })
    await expect(downloader.download(config, bad, root)).rejects.toMatchObject({ code: 'invalid-metadata' })
    expect(calls).toEqual([])
    expect(await readdir(root)).toEqual([])
  })

  it('摘要不同的同名包使用不同缓存目录，Windows 包同样校验', async () => {
    const root = await userData()
    const otherPayload = Buffer.from('other content')
    const otherItem = { ...item, size: otherPayload.length, sha256: digest(otherPayload).toUpperCase() }
    const { downloader } = offline([{ body: payload }, { body: otherPayload }, { body: payload }])
    const first = await downloader.download(config, item, root)
    const second = await downloader.download(config, otherItem, root)
    expect(first).not.toBe(second)
    expect(await downloader.verify(otherItem, second)).toBe(second)
    expect(await downloader.download(config, windowsItem, root)).toBe(cache(root, windowsItem))
  })
})

describe('安装前校验与缓存路径', () => {
  it.each([Buffer.from('short'), Buffer.alloc(payload.length, 0)])(
    '安装前拒绝并删除损坏的普通文件',
    async (corruption) => {
      const root = await userData()
      const { downloader } = offline([{ body: payload }])
      const path = await downloader.download(config, item, root)
      await writeFile(path, corruption)
      await expect(downloader.verify(item, path)).rejects.toMatchObject({ code: 'integrity' })
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('拒绝目录，保留其中内容', async () => {
    const root = await userData()
    const directory = join(root, 'not-an-installer')
    await mkdir(directory)
    await writeFile(join(directory, 'keep'), 'keep')
    await expect(new UpdateDownloader().verify(item, directory)).rejects.toMatchObject({ code: 'unsafe-file' })
    expect(await readFile(join(directory, 'keep'), 'utf8')).toBe('keep')
  })

  it('拒绝硬链接缓存，不改变外部文件内容', async () => {
    const root = await userData()
    const external = join(root, 'external')
    const linked = join(root, 'linked')
    await writeFile(external, payload)
    await link(external, linked)
    await expect(new UpdateDownloader().verify(item, linked)).rejects.toMatchObject({ code: 'unsafe-file' })
    expect(await readFile(external)).toEqual(payload)
    await expect(lstat(linked)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('拒绝符号链接文件和缓存目录，不触碰外部内容', async () => {
    const root = await userData()
    const external = join(root, 'external')
    const linked = join(root, 'linked')
    await writeFile(external, payload)
    await symlink(external, linked)
    await expect(new UpdateDownloader().verify(item, linked)).rejects.toMatchObject({ code: 'unsafe-file' })
    expect(await readFile(external)).toEqual(payload)
    await expect(lstat(linked)).rejects.toMatchObject({ code: 'ENOENT' })
    const externalDirectory = await userData()
    await symlink(externalDirectory, join(root, 'updates'))
    const { downloader, calls } = offline([])
    await expect(downloader.download(config, item, root)).rejects.toMatchObject({ code: 'unsafe-file' })
    expect(calls).toEqual([])
    expect(await readdir(externalDirectory)).toEqual([])
  })
})
