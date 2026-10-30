import { createHash, createPublicKey } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, lstat, readFile, rename, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Schema } from 'effect'
import { verifyUpdateManifest, type SignedUpdateManifest } from '@baton/protocol/update-manifest'
import { NodeUpdateAvailability, NodeUpdatePending, NodeUpdateReport, NodeUpdateRequest } from '@baton/protocol'
import { readPrivateFile } from '../platform/private.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { coordinatorURL, loadCoordinatorCA, loadIdentity } from './identity.ts'
import { join } from 'node:path'
import { isMissing } from './identity.ts'
import { compareUpdateVersions } from './update-version.ts'
import { ReleaseMetadata } from '@baton/protocol/release'
import { readUpgradePackage } from './upgrade-check.ts'
import { readCurrentInstallation, installationPaths } from './update-install.ts'
import { verifyArchive } from './update-archive.ts'
import { randomUUID } from 'node:crypto'
import { readUpdateState } from './update-state.ts'

declare const __BATON_UPDATE_KEYS__: Readonly<Record<string, string>> | undefined

const Keys = Schema.Record(Schema.String, Schema.String)

export async function trustedUpdateKeys(dataDirectory: string): Promise<Readonly<Record<string, string>>> {
  let local: Record<string, string> = {}
  try {
    const bytes = await readPrivateFile(join(dataDirectory, 'update-trust.json'))
    if (bytes.length > 64 * 1024) throw new Error('too large')
    local = Schema.decodeUnknownSync(Keys)(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    if (!isMissing(error)) throw new Error('更新签名信任密钥未配置或无效')
  }
  const keys = { ...(typeof __BATON_UPDATE_KEYS__ === 'undefined' ? {} : __BATON_UPDATE_KEYS__), ...local }
  if (
    !Object.keys(keys).length ||
    Object.values(keys).some(
      (pem) => !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem) || createPublicKey(pem).asymmetricKeyType !== 'ed25519',
    )
  )
    throw new Error('更新签名信任密钥未配置或无效')
  return keys
}

function get(
  url: string,
  options: {
    ca?: string | undefined
    token?: string | undefined
    timeoutMs?: number | undefined
    signal?: AbortSignal | undefined
  },
) {
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        minVersion: 'TLSv1.2',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30000)])
          : AbortSignal.timeout(options.timeoutMs ?? 30000),
        ...(options.ca ? { ca: options.ca } : {}),
        ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error('更新服务请求失败'))
          return
        }
        resolve(response)
      },
    )
    req.once('error', () => reject(new Error('更新服务连接失败')))
    req.end()
  })
}

export async function fetchUpdateManifest(dataDirectory: string): Promise<SignedUpdateManifest> {
  const identity = await loadIdentity(dataDirectory)
  if (!identity.coordinator_url) throw new Error('设备未配置中心地址')
  const response = await get(`${coordinatorURL(identity.coordinator_url)}/api/v1/update/manifest`, {
    ca: await loadCoordinatorCA(dataDirectory),
  })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > 64 * 1024) {
      response.destroy()
      throw new Error('更新清单超过大小限制')
    }
    chunks.push(bytes)
  }
  return verifyUpdateManifest(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
    await trustedUpdateKeys(dataDirectory),
  )
}

export function selectUpdateArtifact(
  manifest: SignedUpdateManifest,
  current: { version: string; commit: string },
  platform = process.platform,
  arch = process.arch,
) {
  const order = compareUpdateVersions(manifest.payload.version, current.version)
  if (order < 0 || (order === 0 && manifest.payload.commit !== current.commit))
    throw new Error('更新清单版本早于或不同于当前构建')
  const artifact = manifest.payload.artifacts.find(
    (entry) => entry.kind === 'daemon' && entry.platform === platform && entry.arch === arch,
  )
  if (!artifact) throw new Error('更新清单不包含当前平台')
  return artifact
}

/** The package is executed only after its signed archive and extracted metadata have been checked. */
export async function verifyExtractedUpdate(
  directory: string,
  manifest: SignedUpdateManifest,
  artifact: SignedUpdateManifest['payload']['artifacts'][number],
) {
  const metadata = Schema.decodeUnknownSync(ReleaseMetadata)(
    JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')),
  )
  if (
    metadata.version !== manifest.payload.version ||
    metadata.commit !== manifest.payload.commit ||
    metadata.protocol_version !== manifest.payload.protocol_version ||
    metadata.platform !== artifact.platform ||
    metadata.arch !== artifact.arch
  )
    throw new Error('更新包与签名清单身份不一致')
  const checked = await readUpgradePackage(directory)
  return checked
}

export async function downloadUpdateArtifact(
  dataDirectory: string,
  artifact: SignedUpdateManifest['payload']['artifacts'][number],
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await loadIdentity(dataDirectory)
  if (!identity.coordinator_url) throw new Error('设备未配置中心地址')
  const response = await get(
    `${coordinatorURL(identity.coordinator_url)}/api/v1/update/artifacts/${encodeURIComponent(artifact.file)}`,
    { ca: await loadCoordinatorCA(dataDirectory), timeoutMs: 30 * 60 * 1000, signal },
  )
  const hash = createHash('sha256')
  let size = 0
  try {
    await pipeline(
      response,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > artifact.size) return callback(new Error('更新包超过声明大小'))
          hash.update(chunk)
          callback(null, chunk)
        },
      }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    )
    if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('更新包摘要或大小不符')
  } catch (error) {
    await rm(target, { force: true })
    throw error
  }
}

async function management(
  dataDirectory: string,
  action: 'pending' | 'request' | 'report' | 'availability',
  body?: typeof NodeUpdateReport.Type | typeof NodeUpdateAvailability.Type,
): Promise<unknown> {
  const identity = await loadIdentity(dataDirectory)
  if (!identity.coordinator_url) throw new Error('设备未配置中心地址')
  const ca = await loadCoordinatorCA(dataDirectory)
  const payload = body ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = request(
      `${coordinatorURL(identity.coordinator_url!)}/api/v1/node-update/${action}`,
      {
        method: action === 'pending' ? 'GET' : 'POST',
        minVersion: 'TLSv1.2',
        signal: AbortSignal.timeout(30000),
        ...(ca ? { ca } : {}),
        headers: {
          authorization: `Bearer ${identity.credential.token}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error('更新管理请求失败'))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 16384) response.destroy()
          else chunks.push(chunk)
        })
        response.once('error', () => reject(new Error('更新管理响应无效')))
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new Error('更新管理响应无效'))
          }
        })
      },
    )
    req.once('error', () => reject(new Error('更新管理连接失败')))
    req.end(payload)
  })
}

export const pendingNodeUpdate = async (dataDirectory: string) =>
  Schema.decodeUnknownSync(NodeUpdatePending)(await management(dataDirectory, 'pending'))
export const requestNodeUpdate = async (dataDirectory: string) =>
  Schema.decodeUnknownSync(NodeUpdateRequest)(await management(dataDirectory, 'request'))
export async function reportNodeUpdate(dataDirectory: string, report: typeof NodeUpdateReport.Type) {
  Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true) }))(
    await management(dataDirectory, 'report', Schema.decodeUnknownSync(NodeUpdateReport)(report)),
  )
}
export async function reportUpdateAvailability(
  dataDirectory: string,
  availability: typeof NodeUpdateAvailability.Type,
) {
  Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true) }))(
    await management(dataDirectory, 'availability', Schema.decodeUnknownSync(NodeUpdateAvailability)(availability)),
  )
}

export async function downloadDesktopFeed(dataDirectory: string, operationId: string, attempt: number) {
  const manifest = await fetchUpdateManifest(dataDirectory)
  const operation = await readUpdateState(dataDirectory)
  if (
    !operation ||
    operation.operation_id !== operationId ||
    operation.attempt !== attempt ||
    operation.target_version !== manifest.payload.version ||
    operation.target_commit !== manifest.payload.commit ||
    !['verifying', 'draining', 'ready', 'migrating', 'syncing'].includes(operation.phase)
  )
    throw new Error('桌面更新与设备操作不匹配')
  const current = await readCurrentInstallation(dataDirectory)
  const order = compareUpdateVersions(manifest.payload.version, current.release.version)
  if (order < 0 || (order === 0 && manifest.payload.commit !== current.release.commit))
    throw new Error('更新清单版本早于或不同于当前构建')
  const platformArtifacts = manifest.payload.artifacts.filter(
    (entry) => entry.platform === process.platform && entry.arch === process.arch,
  )
  const installer = platformArtifacts.find((entry) => entry.kind === 'desktop')
  const feed = platformArtifacts.find((entry) => entry.kind === 'desktop-feed')
  if (
    !installer ||
    !feed ||
    (process.platform === 'darwin'
      ? !installer.file.endsWith('.zip') || feed.file !== 'latest-mac.yml'
      : process.platform === 'win32'
        ? !installer.file.endsWith('.exe') || feed.file !== 'latest.yml'
        : true)
  )
    throw new Error('更新清单不包含当前平台的桌面安装包和更新描述')
  const root = installationPaths(dataDirectory).root
  const cache = join(root, 'desktop')
  await ensurePrivateDirectory(cache)
  const download = async (artifact: typeof installer) => {
    const extension = artifact.kind === 'desktop-feed' ? '.yml' : process.platform === 'darwin' ? '.zip' : '.exe'
    const path = join(cache, `${artifact.sha256}${extension}`)
    try {
      await verifyArchive(path, artifact)
    } catch (error) {
      if (!isMissing(error)) throw error
      const temporary = join(cache, `.download-${randomUUID()}`)
      try {
        const prefetched = join(root, 'downloads', artifact.sha256)
        let present = false
        try {
          const info = await lstat(prefetched)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('更新缓存无效')
          try {
            await verifyArchive(prefetched, artifact)
            await copyFile(prefetched, temporary)
            await verifyArchive(temporary, artifact)
            present = true
          } catch {
            await rm(temporary, { force: true })
            await rm(prefetched, { force: true })
          }
        } catch (failure) {
          if (!isMissing(failure)) throw failure
        }
        if (!present) await downloadUpdateArtifact(dataDirectory, artifact, temporary)
        await verifyArchive(temporary, artifact)
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    return { ...artifact, path }
  }
  const artifacts = [await download(feed), await download(installer)]
  const latest = await readUpdateState(dataDirectory)
  if (
    !latest ||
    latest.operation_id !== operationId ||
    latest.attempt !== attempt ||
    latest.target_version !== manifest.payload.version ||
    latest.target_commit !== manifest.payload.commit ||
    !['verifying', 'draining', 'ready', 'migrating', 'syncing'].includes(latest.phase)
  )
    throw new Error('桌面更新操作已改变')
  return { version: manifest.payload.version, commit: manifest.payload.commit, artifacts }
}
