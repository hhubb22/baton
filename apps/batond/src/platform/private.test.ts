import { constants } from 'node:fs'
import { chmod, lstat, readdir, rm, symlink } from 'node:fs/promises'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  ensurePrivateDirectory,
  openPrivateFile,
  readPrivateFile,
  validatePrivateDirectory,
  writePrivateFile,
} from './private.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory() {
  const path = await makePrivateTempDirectory('baton-private-')
  directories.push(path)
  await ensurePrivateDirectory(path)
  return path
}

describe('private files', () => {
  it('initializes private directories before simultaneous callers validate them', async () => {
    const root = await directory()
    const path = join(root, 'shared')
    await Promise.all(Array.from({ length: 6 }, () => ensurePrivateDirectory(path)))
    await validatePrivateDirectory(path)
    await writePrivateFile(join(path, 'secret'), 'local-private-value')
    expect((await readPrivateFile(join(path, 'secret'))).toString()).toBe('local-private-value')
  })

  it('atomically replaces complete files and opens append without truncation', async () => {
    const path = await directory()
    const file = join(path, 'mapping.json')
    await writePrivateFile(file, '{"session":"one"}')
    await writePrivateFile(file, '{"session":"two"}')
    const append = await openPrivateFile(file, constants.O_WRONLY | constants.O_APPEND)
    try {
      await append.writeFile('\n')
    } finally {
      await append.close()
    }
    expect((await readPrivateFile(file)).toString()).toBe('{"session":"two"}\n')
    expect(await readdir(path)).toEqual(['mapping.json'])
    if (process.platform !== 'win32') {
      expect((await lstat(path)).mode & 0o777).toBe(0o700)
      expect((await lstat(file)).mode & 0o777).toBe(0o600)
    }
    await expect(openPrivateFile(file, constants.O_WRONLY | constants.O_TRUNC)).rejects.toThrow('without truncation')
  })

  // junction 只能在 Windows 文件系统上创建。
  it.skipIf(process.platform !== 'win32')('rejects directory junctions', async () => {
    const root = await directory()
    const path = join(root, "credentials's ‘left’ ‚low‛ [目录] $literal")
    await ensurePrivateDirectory(path)
    await writePrivateFile(join(path, 'secret'), 'local-private-value')
    const alias = join(root, 'alias')
    await symlink(path, alias, 'junction')
    await expect(ensurePrivateDirectory(alias)).rejects.toThrow('type')
    await expect(readPrivateFile(join(alias, 'secret'))).rejects.toThrow('type')
  })

  // Windows does not use POSIX mode bits.
  it.skipIf(process.platform === 'win32')('rejects symlinks and restores private permissions', async () => {
    const path = await directory()
    const file = join(path, 'secret')
    await writePrivateFile(file, 'original')
    const alias = join(path, 'alias')
    await symlink(file, alias)
    await expect(readPrivateFile(alias)).rejects.toThrow('type')
    await expect(openPrivateFile(alias, constants.O_WRONLY | constants.O_APPEND)).rejects.toThrow('type')
    await expect(writePrivateFile(alias, 'replacement')).rejects.toThrow('type')
    await symlink(path, join(path, 'directory-alias'))
    await expect(ensurePrivateDirectory(join(path, 'directory-alias'))).rejects.toThrow('type')
    await chmod(file, 0o644)
    await chmod(path, 0o755)
    expect((await readPrivateFile(file)).toString()).toBe('original')
    expect((await lstat(path)).mode & 0o7777).toBe(0o700)
    expect((await lstat(file)).mode & 0o7777).toBe(0o600)
  })
})
