import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePrivateDirectory, openPrivateFile, readPrivateFile, writePrivateFile } from './private.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'baton-private-'))
  directories.push(path)
  await ensurePrivateDirectory(path)
  return path
}

describe('private files', () => {
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
