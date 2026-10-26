import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { hasCode } from './errors.ts'
import { powershell, systemCommand, windowsTool } from './identity.ts'

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

export function parseWindowsUserSid(output: string): string {
  const sid = /,"(S-1-(?:\d+-)+\d+)"\s*$/.exec(output)?.[1]
  if (!sid) throw new Error('Cannot determine current Windows user SID')
  return sid
}

let sidPromise: Promise<string> | undefined
async function currentSid(): Promise<string> {
  return (sidPromise ??= systemCommand(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then(
    parseWindowsUserSid,
  ))
}

const sddlSids = new Map<string, Promise<string>>()

async function numericWindowsSid(value: string): Promise<string> {
  if (!/^[A-Z]{2}$/.test(value)) return value
  let pending = sddlSids.get(value)
  if (!pending) {
    // SDDL abbreviations (including LA) are SIDs, not localized account names.
    pending = powershell(
      `([System.Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;${value})')).DiscretionaryAcl[0].SecurityIdentifier.Value`,
    )
    sddlSids.set(value, pending)
  }
  return pending
}

export async function validateWindowsDirectorySddl(sddl: string | undefined, sid: string): Promise<void> {
  const diagnostic = `current user SID ${sid}; SDDL: ${sddl ?? '<missing>'}`
  if (!sddl || !sddl.startsWith('D:P')) throw new Error(`Private directory inherits ACLs: ${diagnostic}`)
  const entries = [...sddl.split('S:', 1)[0].matchAll(/\(([^()]*)\)/g)]
  if (entries.length !== 1)
    throw new Error(`Private directory must grant only the current user (${entries.length} ACL entries): ${diagnostic}`)
  const fields = entries[0][1].split(';')
  if (
    fields.length !== 6 ||
    fields[0] !== 'A' ||
    fields[1] !== 'OICI' ||
    fields[2] !== 'FA' ||
    fields[3] !== '' ||
    fields[4] !== '' ||
    (await numericWindowsSid(fields[5]).catch(() => '')) !== sid
  )
    throw new Error(`Invalid private directory ACL: ${diagnostic}`)
}

/** icacls has no per-handle validation. Reparse and concurrent ACL changes remain Windows limitations. */
async function checkDirectoryAcl(path: string): Promise<void> {
  const sid = await currentSid()
  // /save emits language-independent SDDL, including standard SID abbreviations.
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
    await validateWindowsDirectorySddl(sddl, sid)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function validatePrivateDirectory(path: string): Promise<void> {
  checkStat(path, await lstat(path), true)
  if (process.platform === 'win32') await checkDirectoryAcl(path)
}

async function setDirectoryAcl(path: string): Promise<void> {
  const sid = await currentSid()
  const encodedPath = Buffer.from(resolve(path), 'utf8').toString('base64')
  // Replace the protected DACL in one operation; resetting inheritance can expose existing contents.
  await powershell(`
    $acl = [System.Security.AccessControl.DirectorySecurity]::new();
    $acl.SetAccessRuleProtection($true, $false);
    $identity = [System.Security.Principal.SecurityIdentifier]::new('${sid}');
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow');
    $acl.AddAccessRule($rule);
    $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
    [System.IO.DirectoryInfo]::new($path).SetAccessControl($acl);
  `)
}

/** 显式保护操作收紧当前用户已有目录；普通验证不会修改权限。 */
export async function protectPrivateDirectory(path: string): Promise<void> {
  const before = await lstat(path)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Invalid private directory type')
  if (process.platform === 'win32') await setDirectoryAcl(path)
  else {
    if (before.uid !== process.getuid?.()) throw new Error('Private directory has a different owner')
    await chmod(path, 0o700)
  }
  const after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new Error('Private directory changed during protection')
  await validatePrivateDirectory(path)
}

const pendingDirectories = new Map<string, Promise<void>>()

/** Creates one directory; its parent must already exist. Existing unsafe paths are rejected. */
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
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  if (created && process.platform === 'win32') await setDirectoryAcl(path)
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
