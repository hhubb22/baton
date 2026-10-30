import { randomUUID } from 'node:crypto'
import { lstat, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { verifyUpdateManifest } from '@baton/protocol/update-manifest'
import { acquireProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { isMissing } from './identity.ts'
import { verifyArchive } from './update-archive.ts'
import { installationPaths, readCurrentInstallation } from './update-install.ts'
import {
  downloadUpdateArtifact,
  fetchUpdateManifest,
  selectUpdateArtifact,
  trustedUpdateKeys,
} from './update-network.ts'
import { compareUpdateVersions } from './update-version.ts'
import { readUpdateState } from './update-state.ts'

export const UpdatePolicy = Schema.Literals(['manual', 'idle'])
export type UpdatePolicy = typeof UpdatePolicy.Type
const SavedPolicy = Schema.Struct({ policy: UpdatePolicy })

export async function readUpdatePolicy(directory: string): Promise<UpdatePolicy> {
  try {
    const bytes = await readPrivateFile(join(directory, 'update-policy.json'))
    if (bytes.length > 4096) throw new Error('too large')
    return Schema.decodeUnknownSync(SavedPolicy)(JSON.parse(bytes.toString('utf8'))).policy
  } catch (error) {
    if (isMissing(error)) return 'manual'
    throw new Error('更新策略无效')
  }
}

export async function saveUpdatePolicy(directory: string, input: UpdatePolicy): Promise<UpdatePolicy> {
  const policy = Schema.decodeUnknownSync(UpdatePolicy)(input)
  await ensurePrivateDirectory(directory)
  const release = await acquireProcessLock(join(directory, 'update-policy.lock'))
  try {
    await writePrivateFileAtomic(join(directory, 'update-policy.json'), JSON.stringify({ policy }))
    return policy
  } finally {
    await release()
  }
}

type Artifact = Awaited<ReturnType<typeof fetchUpdateManifest>>['payload']['artifacts'][number]
export type BackgroundResult =
  | { status: 'current'; version: string }
  | { status: 'downloaded' | 'started'; version: string; artifact: Artifact; path: string }

async function mayStart(directory: string, version: string): Promise<boolean> {
  const state = await readUpdateState(directory)
  if (!state) return true
  if (!['completed', 'cancelled', 'failed'].includes(state.phase)) return false
  return !(['cancelled', 'failed'].includes(state.phase) && (!state.target_version || state.target_version === version))
}

/** A task starting after the idle check remains subject to the normal draining barrier. */
export async function checkBackgroundUpdate(
  directory: string,
  options: {
    isIdle: () => Promise<boolean>
    start: () => Promise<void>
    fetchManifest?: typeof fetchUpdateManifest
    currentInstallation?: typeof readCurrentInstallation
    download?: typeof downloadUpdateArtifact
  },
): Promise<BackgroundResult> {
  const manifest = await (options.fetchManifest ?? fetchUpdateManifest)(directory)
  const current = await (options.currentInstallation ?? readCurrentInstallation)(directory)
  const artifact = selectUpdateArtifact(manifest, current.release)
  const sameVersion = compareUpdateVersions(manifest.payload.version, current.release.version) === 0
  const desktop = manifest.payload.artifacts.find(
    (item) => item.kind === 'desktop' && item.platform === process.platform && item.arch === process.arch,
  )
  if (sameVersion && !desktop) {
    await rm(join(directory, 'update-candidate.json'), { force: true })
    return { status: 'current', version: manifest.payload.version }
  }

  const paths = installationPaths(directory)
  await ensurePrivateDirectory(paths.root)
  const cache = join(paths.root, 'downloads')
  await ensurePrivateDirectory(cache)
  const path = join(cache, artifact.sha256)
  const lock = await acquireProcessLock(join(directory, 'update-download.lock'))
  try {
    for (const item of [...(sameVersion ? [] : [artifact]), ...(desktop ? [desktop] : [])]) {
      const target = join(cache, item.sha256)
      let present = false
      try {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('更新缓存不是普通文件')
        try {
          await verifyArchive(target, item)
          present = true
        } catch {
          await rm(target)
        }
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      if (!present) {
        const temporary = join(cache, `.download-${randomUUID()}`)
        try {
          await (options.download ?? downloadUpdateArtifact)(directory, item, temporary)
          const info = await lstat(temporary)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('更新缓存不是普通文件')
          await verifyArchive(temporary, item)
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true })
        }
      }
    }
    if (sameVersion) await rm(join(directory, 'update-candidate.json'), { force: true })
    else await writePrivateFileAtomic(join(directory, 'update-candidate.json'), JSON.stringify(manifest))
  } finally {
    await lock()
  }

  if (sameVersion) return { status: 'current', version: manifest.payload.version }

  const release = await acquireProcessLock(join(directory, 'update-policy.lock'))
  try {
    if (
      (await readUpdatePolicy(directory)) === 'idle' &&
      (await mayStart(directory, manifest.payload.version)) &&
      (await options.isIdle())
    ) {
      await options.start()
      return { status: 'started', version: manifest.payload.version, artifact, path }
    }
    return { status: 'downloaded', version: manifest.payload.version, artifact, path }
  } finally {
    await release()
  }
}

/** Retry the idle decision from signed cached evidence without another network check. */
export async function tryIdleUpdate(
  directory: string,
  options: {
    isIdle: () => Promise<boolean>
    start: () => Promise<void>
    keys?: typeof trustedUpdateKeys
    currentInstallation?: typeof readCurrentInstallation
  },
): Promise<boolean> {
  const policyLock = await acquireProcessLock(join(directory, 'update-policy.lock'))
  try {
    if ((await readUpdatePolicy(directory)) !== 'idle') return false
    let bytes: Buffer
    try {
      bytes = await readPrivateFile(join(directory, 'update-candidate.json'))
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (bytes.length > 64 * 1024) throw new Error('更新清单超过大小限制')
    const manifest = verifyUpdateManifest(
      JSON.parse(bytes.toString('utf8')),
      await (options.keys ?? trustedUpdateKeys)(directory),
    )
    const current = await (options.currentInstallation ?? readCurrentInstallation)(directory)
    const artifact = selectUpdateArtifact(manifest, current.release)
    if (compareUpdateVersions(manifest.payload.version, current.release.version) === 0) return false
    if (!(await mayStart(directory, manifest.payload.version))) return false
    const path = join(installationPaths(directory).root, 'downloads', artifact.sha256)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('更新缓存不是普通文件')
    await verifyArchive(path, artifact)
    if (!(await options.isIdle())) return false
    await options.start()
    return true
  } finally {
    await policyLock()
  }
}
