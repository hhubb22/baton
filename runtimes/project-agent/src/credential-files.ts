import { constants, type Stats } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const maximumCredentialBytes = 64 * 1024

function check(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error('credential_path_invalid')
  if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) throw new Error('credential_owner_invalid')
}

/** POSIX 权限不是 0700/0600 时直接改回，不因权限不符拒绝访问。 */
const needsMode = (stat: Stats, directory: boolean) =>
  process.platform !== 'win32' && (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)

async function validate(path: string, directory: boolean): Promise<Stats> {
  const stat = await fs.lstat(path)
  check(stat, directory)
  return stat
}

async function validateDirectory(path: string): Promise<void> {
  const stat = await validate(path, true)
  if (needsMode(stat, true)) await fs.chmod(path, 0o700)
}

async function existingFile(path: string): Promise<void> {
  try {
    await validate(path, false)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
  }
}

export const directCredentialFiles = {
  async protect(path: string, directory: boolean): Promise<void> {
    if (directory) return validateDirectory(path)
    const stat = await validate(path, false)
    if (needsMode(stat, false)) await fs.chmod(path, 0o600)
  },
  async read(path: string): Promise<string | undefined> {
    try {
      await validateDirectory(dirname(path))
      const before = await validate(path, false)
      const handle = await fs.open(
        path,
        constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      )
      try {
        const actual = await handle.stat()
        check(actual, false)
        const after = await validate(path, false)
        if (
          actual.dev !== before.dev ||
          actual.ino !== before.ino ||
          actual.dev !== after.dev ||
          actual.ino !== after.ino
        )
          throw new Error('credential_path_invalid')
        if (needsMode(actual, false)) await handle.chmod(0o600)
        if (actual.size > maximumCredentialBytes) throw new Error('credential_permissions_invalid')
        const buffer = Buffer.alloc(maximumCredentialBytes + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > maximumCredentialBytes) throw new Error('credential_permissions_invalid')
        return buffer.subarray(0, size).toString('utf8')
      } finally {
        await handle.close()
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  },
  async write(path: string, input: string): Promise<void> {
    if (Buffer.byteLength(input) > maximumCredentialBytes) throw new Error('credential_private_file_failed')
    const parent = dirname(path)
    await validateDirectory(parent)
    await existingFile(path)
    const temporary = join(parent, `.credential-${randomUUID()}`)
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        await handle.writeFile(input)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await existingFile(path)
      await fs.rename(temporary, path)
      if (process.platform !== 'win32') {
        const directory = await fs.open(parent, constants.O_RDONLY)
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } finally {
      await fs.rm(temporary, { force: true })
    }
  },
}
