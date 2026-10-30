import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { basename, join } from 'node:path'
import { MacUpdater, NsisUpdater } from 'electron-updater'
import type { SignedUpdateManifest } from '@baton/protocol/update-manifest'
import { verifyDesktopDownload } from './update-download.ts'

type Artifact = {
  path: string
  file: string
  size: number
  sha256: string
  kind: string
  platform: string
  arch: string
}

export async function createLocalUpdateFeed(artifacts: ReadonlyArray<Pick<Artifact, 'file' | 'path' | 'size'>>) {
  const server = createServer((request, response) => {
    const address = server.address()
    const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
    const url = request.url
    const pathname = url?.startsWith('/') && !url.startsWith('//') ? new URL(url, `http://${host}`).pathname : ''
    const file = request.headers.host === host ? artifacts.find((item) => pathname === `/${item.file}`) : undefined
    if (!file || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Length': file.size, 'Cache-Control': 'no-store' })
    if (request.method === 'HEAD') response.end()
    else
      createReadStream(file.path)
        .on('error', () => response.destroy())
        .pipe(response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('无法启动本地更新源')
  }
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

export function validateUpdateInfo(
  info: { version: string; files: Array<{ url: string; size?: number }>; path?: string } | undefined,
  version: string,
  file: { file: string; size: number },
  platform: string,
): void {
  if (
    !info ||
    info.version !== version.replace(/^v/, '') ||
    !info.files?.some((entry) => entry.url === file.file && entry.size === file.size) ||
    info.files.some(
      (entry) =>
        entry.url !== file.file && !(platform === 'darwin' && entry.url === file.file.replace(/\.zip$/, '.dmg')),
    ) ||
    (info.path && info.path !== file.file)
  )
    throw new Error('更新元数据与签名安装包不一致')
}

export async function prepareDesktopInstaller(options: {
  manifest: SignedUpdateManifest
  dataDirectory: string
  downloaded: { version: string; commit: string; artifacts: ReadonlyArray<Artifact> }
}): Promise<{ install: () => void; close: () => void }> {
  const { manifest, downloaded, dataDirectory } = options
  if (
    downloaded.version !== manifest.payload.version ||
    downloaded.commit !== manifest.payload.commit ||
    downloaded.artifacts.length !== 2
  )
    throw new Error('更新文件与签名清单不一致')
  for (const kind of ['desktop', 'desktop-feed']) {
    const matches = downloaded.artifacts.filter((item) => item.kind === kind)
    const signed = manifest.payload.artifacts.filter(
      (item) => item.kind === kind && item.platform === process.platform && item.arch === process.arch,
    )
    if (matches.length !== 1 || signed.length !== 1) throw new Error('更新文件不完整')
    const item = matches[0]!
    const original = signed[0]!
    const extension = kind === 'desktop-feed' ? '.yml' : process.platform === 'darwin' ? '.zip' : '.exe'
    if (
      item.file !== original.file ||
      basename(item.file) !== item.file ||
      item.size !== original.size ||
      item.sha256 !== original.sha256 ||
      item.platform !== original.platform ||
      item.arch !== original.arch ||
      item.path !== join(dataDirectory, 'installation', 'desktop', `${item.sha256}${extension}`)
    )
      throw new Error('更新文件与签名清单不一致')
    await verifyDesktopDownload(item, item.path)
  }
  const packageFile = downloaded.artifacts.find((item) => item.kind === 'desktop')!
  const server = await createLocalUpdateFeed(downloaded.artifacts)
  try {
    const config = { provider: 'generic' as const, url: server.url }
    const updater = process.platform === 'darwin' ? new MacUpdater(config) : new NsisUpdater(config)
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = true
    updater.channel = 'latest'
    updater.disableDifferentialDownload = true
    updater.disableWebInstaller = true
    const result = await updater.checkForUpdates()
    const info = result?.updateInfo
    validateUpdateInfo(info, downloaded.version, packageFile, process.platform)
    await updater.downloadUpdate()
    return { install: () => updater.quitAndInstall(), close: server.close }
  } catch (error) {
    server.close()
    throw error
  }
}
