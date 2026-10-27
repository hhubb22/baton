import { execFile } from 'node:child_process'
import { request } from 'node:https'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'
import { ReleaseMetadata, LEDGER_VERSIONS } from '@baton/protocol/release'
import { checkStorageFormat, StorageFormatError } from '../storage-format.ts'
import { storageBaseline as nodeBaseline } from './ledger.ts'
import { storageBaseline as projectBaseline } from '../project/ledger.ts'
import { storageBaseline as threadBaseline } from '../worker/ledger.ts'
import { coordinatorURL, isMissing, loadIdentity, loadCoordinatorCA } from './identity.ts'
import { IPCError } from './ipc.ts'
import { backupSpace } from './upgrade-backup.ts'

export const sameRelease = (left: ReleaseMetadata, right: ReleaseMetadata) =>
  left.version === right.version &&
  left.commit === right.commit &&
  left.platform === right.platform &&
  left.arch === right.arch &&
  left.protocol_version === right.protocol_version &&
  left.schema_version === right.schema_version &&
  left.ledger_versions.node === right.ledger_versions.node &&
  left.ledger_versions.project === right.ledger_versions.project &&
  left.ledger_versions.thread === right.ledger_versions.thread &&
  JSON.stringify(left.supported_daemon_versions) === JSON.stringify(right.supported_daemon_versions)

export async function readUpgradePackage(target: string) {
  try {
    const path = await realpath(target)
    const release = Schema.decodeUnknownSync(ReleaseMetadata)(
      JSON.parse(await readFile(join(path, 'release.json'), 'utf8')),
    )
    if (!release.version.trim() || !release.commit.trim()) throw new Error('缺少构建身份')
    const binary = join(path, process.platform === 'win32' ? 'batond.exe' : 'batond')
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ['--version'],
        { cwd: path, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
    const actual = Schema.decodeUnknownSync(ReleaseMetadata)(JSON.parse(stdout))
    if (!sameRelease(release, actual)) throw new Error('目标程序 --version 与 release.json 不符')
    return { path, release }
  } catch (error) {
    throw new IPCError(
      'upgrade_package_invalid',
      error instanceof Error ? `目标安装包无效：${error.message}` : '目标安装包无效',
    )
  }
}

/** 只列出三类账本；缺失的根账本可建立首版基线，不猜测旧实验文件。 */
export async function upgradeLedgers(directory: string) {
  const files = [
    { path: join(directory, 'node.db'), kind: 'node' as const, baseline: nodeBaseline },
    { path: join(directory, 'project-runtime.db'), kind: 'project' as const, baseline: projectBaseline },
  ] as Array<{ path: string; kind: 'node' | 'project' | 'thread'; baseline: readonly string[] }>
  let threads: string[] = []
  try {
    threads = await readdir(join(directory, 'threads'))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const id of threads.sort()) {
    if (!Schema.is(UUID)(id)) continue
    const path = join(directory, 'threads', id, 'thread.db')
    try {
      await stat(path)
      files.push({ path, kind: 'thread', baseline: threadBaseline })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return files
}

export function centerRelease(url: string, ca?: string): Promise<ReleaseMetadata> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new IPCError('upgrade_coordinator_unavailable', '无法读取当前中心发布信息'))
    const req = request(
      `${coordinatorURL(url)}/api/v1/release`,
      {
        method: 'GET',
        minVersion: 'TLSv1.2',
        ...(ca ? { ca } : {}),
        signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 64 * 1024) {
            res.destroy()
            fail()
          } else chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('中心拒绝发布查询')
            resolve(Schema.decodeUnknownSync(ReleaseMetadata)(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
          } catch {
            fail()
          }
        })
      },
    )
    req.on('error', fail)
    req.end()
  })
}

export async function checkUpgradeStorage(directory: string, release: ReleaseMetadata) {
  for (const file of await upgradeLedgers(directory)) {
    checkStorageFormat(file.path, file.kind, file.baseline)
    const version = LEDGER_VERSIONS[file.kind]
    if (release.ledger_versions[file.kind] !== version)
      throw new IPCError(
        'storage_version_unsupported',
        `${file.kind} 当前格式 ${version}，目标只声明格式 ${release.ledger_versions[file.kind]}`,
      )
  }
}

export async function currentCenterRelease(directory: string, ca?: string) {
  const identity = await loadIdentity(directory)
  if (!identity.coordinator_url) throw new IPCError('upgrade_coordinator_unavailable', '身份文件缺少当前中心地址')
  return centerRelease(identity.coordinator_url, ca ?? (await loadCoordinatorCA(directory)))
}

export async function checkUpgrade(directory: string, target: string, ca?: string) {
  try {
    const { path, release } = await readUpgradePackage(target)
    await checkUpgradeStorage(directory, release)
    const center = await currentCenterRelease(directory, ca)
    if (
      center.protocol_version !== release.protocol_version ||
      (center.version !== 'development' &&
        release.version !== 'development' &&
        !center.supported_daemon_versions.includes(release.version))
    )
      throw new IPCError(
        'node_version_incompatible',
        `中心 ${center.version} / 协议 ${center.protocol_version} 不支持目标 ${release.version} / 协议 ${release.protocol_version}；请先升级中心`,
      )
    const space = await backupSpace(directory)
    return { ok: true as const, target_path: path, release, center, ...space }
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof IPCError || error instanceof StorageFormatError ? error.code : 'upgrade_check_failed',
      reason: error instanceof Error ? error.message : '升级预检失败',
    }
  }
}
