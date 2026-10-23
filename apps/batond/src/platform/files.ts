import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { hasCode, platformEffect } from './errors.ts'
import { systemCommand, windowsTool } from './identity.ts'

function checkStat(path: string, stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error(`Invalid private ${directory ? 'directory' : 'file'} type: ${path}`)
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid?.()) throw new Error(`Private path has a different owner: ${path}`)
    if ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600))
      throw new Error(`Invalid private path permissions: ${path}`)
    if (!directory && stat.nlink !== 1) throw new Error(`Private file has multiple hard links: ${path}`)
  }
}

let sidPromise: Promise<string> | undefined
async function currentSid(): Promise<string> {
  return (sidPromise ??= systemCommand(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then((output) => {
    const sid = /S-1-(?:\d+-)+\d+/.exec(output)?.[0]
    if (!sid) throw new Error('Cannot determine current Windows user SID')
    return sid
  }))
}

/** icacls has no per-handle validation. Reparse and concurrent ACL changes remain Windows limitations. */
async function checkDirectoryAcl(path: string): Promise<void> {
  const sid = await currentSid()
  // /save emits SDDL with numeric SIDs regardless of the display language.
  const temporary = await mkdtemp(join(tmpdir(), 'baton-acl-'))
  const aclFile = join(temporary, 'directory.acl')
  try {
    await systemCommand(windowsTool('icacls.exe'), [path, '/save', aclFile, '/Q'])
    const handle = await open(aclFile, 'r')
    let content: string
    try {
      content = (await handle.readFile()).toString('utf16le')
    } finally {
      await handle.close()
    }
    const sddl = content.split(/\r?\n/).find((line) => line.startsWith('D:'))
    if (!sddl || !sddl.startsWith('D:P')) throw new Error(`Private directory inherits ACLs: ${path}`)
    const entries = [...sddl.matchAll(/\(([^()]*)\)/g)]
    if (entries.length !== 1) throw new Error(`Private directory must grant only the current user: ${path}`)
    const fields = entries[0][1].split(';')
    if (fields.length !== 6 || fields[0] !== 'A' || fields[1] !== 'OICI' || fields[2] !== 'FA' || fields[5] !== sid)
      throw new Error(`Invalid private directory ACL: ${path}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function validatePrivateDirectory(path: string): Promise<void> {
  checkStat(path, await lstat(path), true)
  if (process.platform === 'win32') await checkDirectoryAcl(path)
}

/** Creates one directory; its parent must already exist. Existing unsafe paths are rejected. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  if (created && process.platform === 'win32') {
    const sid = await currentSid()
    await systemCommand(windowsTool('icacls.exe'), [
      resolve(path),
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '/Q',
    ])
  }
  await validatePrivateDirectory(path)
}

async function validateFile(path: string): Promise<Stats> {
  const stat = await lstat(path)
  checkStat(path, stat, false)
  return stat
}

export async function openPrivateFile(path: string, flags: number = constants.O_RDONLY): Promise<FileHandle> {
  if (flags & (constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL))
    throw new Error('openPrivateFile only opens existing files without truncation')
  await validatePrivateDirectory(dirname(path))
  const before = await validateFile(path)
  const handle = await open(
    path,
    flags | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  )
  try {
    const actual = await handle.stat()
    checkStat(path, actual, false)
    const after = await validateFile(path)
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.dev !== after.dev || actual.ino !== after.ino)
      throw new Error(`Private file changed during open: ${path}`)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function readPrivateFile(path: string): Promise<Buffer> {
  const handle = await openPrivateFile(path)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Same-directory rename, file fsync, then POSIX directory fsync. Does not repair unsafe existing paths. */
export async function writePrivateFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const parent = dirname(path)
  await validatePrivateDirectory(parent)
  try {
    await validateFile(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  const temporary = join(parent, `.private-${randomUUID()}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await unlink(temporary)
    throw error
  } finally {
    await handle.close()
  }
  try {
    try {
      await validateFile(path)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const directory = await open(parent, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error
    })
  }
}

export const PrivateFiles = {
  ensureDirectory: (path: string) => platformEffect('private directory', () => ensurePrivateDirectory(path)),
  read: (path: string) => platformEffect('read private file', () => readPrivateFile(path)),
  writeAtomic: (path: string, data: string | Uint8Array) =>
    platformEffect('write private file', () => writePrivateFileAtomic(path, data)),
}
