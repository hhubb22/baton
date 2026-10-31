import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasCode } from './errors.ts'
import { isDefaultDataDirectory } from './layout.ts'

/** Windows 上目标文件被其他句柄打开时 rename 返回 EPERM、EACCES 或 EBUSY，句柄通常很快关闭，按递增间隔重试约 1 秒。 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      const busy = ['EPERM', 'EACCES', 'EBUSY'].some((code) => hasCode(error, code))
      if (process.platform !== 'win32' || !busy || attempt > 10) throw error
      await sleep(attempt * 20)
    }
  }
}

function checkStat(path: string, stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error(`Invalid private ${directory ? 'directory' : 'file'} type: ${path}`)
  if (process.platform !== 'win32' && stat.uid !== process.getuid?.())
    throw new Error(`Private path has a different owner: ${path}`)
}

/** POSIX 权限不是 0700/0600 时直接改回，不因权限不符拒绝访问。 */
const needsMode = (stat: Stats, mode: number) => process.platform !== 'win32' && (stat.mode & 0o7777) !== mode

/**
 * 检查目录类型与属主，POSIX 权限不符时改回 0700。
 * Windows 沿用数据目录继承的 ACL；默认数据目录位于用户目录下，只授权当前用户、SYSTEM 与 Administrators。
 */
export async function validatePrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  checkStat(path, stat, true)
  if (needsMode(stat, 0o700)) await chmod(path, 0o700)
}

const pendingDirectories = new Map<string, Promise<void>>()

/** Creates one directory; its parent must already exist. Existing symlinks, wrong types and other owners are rejected. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  const key = resolve(path)
  const pending = pendingDirectories.get(key)
  if (pending) {
    await pending
    return validatePrivateDirectory(path)
  }
  const creating = createPrivateDirectory(path)
  pendingDirectories.set(key, creating)
  try {
    await creating
  } finally {
    pendingDirectories.delete(key)
  }
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    // 默认数据目录是唯一多一层上级（~/.baton）的目录，其他路径的上级缺失仍然报错。
    await mkdir(path, { mode: 0o700, recursive: isDefaultDataDirectory(path) })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
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
    if (needsMode(actual, 0o600)) await handle.chmod(0o600)
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

/** Same-directory rename, file fsync, then POSIX directory fsync. The replacement file is created with 0600. */
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
    await replaceFile(temporary, path)
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
