import { constants } from 'node:fs'
import { chmod, lstat, mkdir, realpath, readdir, rename, rm, symlink } from 'node:fs/promises'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  ensurePrivateDirectory,
  openPrivateFile,
  protectPrivateDirectory,
  readPrivateFile,
  validatePrivateDirectory,
  writePrivateFile,
} from './private.ts'
import { systemCommand, windowsTool } from './identity.ts'

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

  // Windows DACL 与 junction 规则需要在 Windows 文件系统上验证。
  it.skipIf(process.platform !== 'win32')(
    'protects inherited ACLs, removes other grants and rejects junctions',
    async () => {
      const root = await directory()
      const path = join(root, "credentials's ‘left’ ‚low‛ [目录] $literal")
      await mkdir(path)
      await expect(ensurePrivateDirectory(path)).rejects.toThrow('inherits ACLs')
      await protectPrivateDirectory(path)
      await ensurePrivateDirectory(path)
      const temporarySpelling = join(tmpdir(), relative(await realpath(tmpdir()), path))
      await validatePrivateDirectory(temporarySpelling)
      await writePrivateFile(join(path, 'secret'), 'local-private-value')
      await systemCommand(windowsTool('icacls.exe'), [path, '/grant', '*S-1-5-32-544:(OI)(CI)F', '/Q'])
      const relocated = join(root, 'relocated')
      await rename(path, relocated)
      await expect(validatePrivateDirectory(relocated)).rejects.toThrow('only the current user')
      await expect(ensurePrivateDirectory(relocated)).rejects.toThrow('only the current user')
      await protectPrivateDirectory(relocated)
      await ensurePrivateDirectory(relocated)
      expect((await readPrivateFile(join(relocated, 'secret'))).toString()).toBe('local-private-value')
      const alias = join(root, 'alias')
      await symlink(relocated, alias, 'junction')
      await expect(ensurePrivateDirectory(alias)).rejects.toThrow('type')
    },
  )

  // POSIX mode bits and file symlinks do not implement the Windows directory ACL contract.
  it.skipIf(process.platform === 'win32')(
    'rejects symlinks and unsafe existing permissions without repairing them',
    async () => {
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
      await expect(readPrivateFile(file)).rejects.toThrow('permissions')
      await expect(writePrivateFile(file, 'replacement')).rejects.toThrow('permissions')
      expect((await lstat(file)).mode & 0o777).toBe(0o644)
      await chmod(path, 0o755)
      await expect(ensurePrivateDirectory(path)).rejects.toThrow('permissions')
    },
  )
})
