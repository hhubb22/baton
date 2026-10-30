import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { expect, it } from 'vite-plus/test'
import { extractUpdateArchive } from './update-archive.ts'

async function withArchive(test: (directory: string, archive: string) => Promise<void>, prefix?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'baton-update-archive-'))
  try {
    await mkdir(join(directory, 'package'))
    await writeFile(join(directory, 'package', 'batond'), 'offline package contents', { mode: 0o700 })
    await chmod(join(directory, 'package', 'batond'), 0o700)
    const archive = join(directory, 'release.tar.gz')
    await tar.c({ cwd: directory, gzip: true, file: archive, ...(prefix ? { prefix } : {}) }, ['package'])
    await test(directory, archive)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function artifact(path: string) {
  const bytes = await readFile(path)
  return {
    kind: 'daemon' as const,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    file: 'release.tar.gz',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

it('extracts a verified archive and preserves executable permissions', () =>
  withArchive(async (directory, archive) => {
    const target = join(directory, 'installed')
    await extractUpdateArchive(archive, target, await artifact(archive))
    expect(await readFile(join(target, 'batond'), 'utf8')).toBe('offline package contents')
    if (process.platform !== 'win32') expect((await stat(join(target, 'batond'))).mode & 0o100).toBe(0o100)
  }))

it('rejects altered archive bytes before creating an installation', () =>
  withArchive(async (directory, archive) => {
    const signed = await artifact(archive)
    const bytes = await readFile(archive)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await writeFile(archive, bytes)
    const target = join(directory, 'installed')
    await expect(extractUpdateArchive(archive, target, signed)).rejects.toThrow('摘要')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  }))

it('cleans extraction when a later entry duplicates an already accepted path', () =>
  withArchive(async (directory, archive) => {
    await tar.c({ cwd: directory, gzip: true, file: archive }, ['package', 'package/batond'])
    const target = join(directory, 'installed')
    await expect(extractUpdateArchive(archive, target, await artifact(archive))).rejects.toThrow('重复')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  }))

it('rejects traversal paths and removes incomplete extraction without modifying neighboring files', () =>
  withArchive(async (directory, archive) => {
    const neighbor = join(directory, 'sentinel')
    await writeFile(neighbor, 'unchanged')
    const target = join(directory, 'installed')
    await expect(extractUpdateArchive(archive, target, await artifact(archive))).rejects.toThrow('路径')
    expect(await readFile(neighbor, 'utf8')).toBe('unchanged')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  }, '..'))

// 用 zip -X 打包包含 package/batond 的本地离线文件。
const zipFixture =
  'UEsDBAoAAAAAAMqoXl0AAAAAAAAAAAAAAAAIAAAAcGFja2FnZS9QSwMECgAAAAAAyqheXS+lMRMUAAAAFAAAAA4AAABwYWNrYWdlL2JhdG9uZG9mZmxpbmUgemlwIHBhY2thZ2UKUEsBAh4DCgAAAAAAyqheXQAAAAAAAAAAAAAAAAgAAAAAAAAAAAAQAO1BAAAAAHBhY2thZ2UvUEsBAh4DCgAAAAAAyqheXS+lMRMUAAAAFAAAAA4AAAAAAAAAAQAAAKSBJgAAAHBhY2thZ2UvYmF0b25kUEsFBgAAAAACAAIAcgAAAGYAAAAAAA=='

it('extracts a ZIP locally and rejects ZIP traversal entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-update-zip-'))
  try {
    const archive = join(directory, 'release.zip')
    await writeFile(archive, Buffer.from(zipFixture, 'base64'))
    const metadata = { ...(await artifact(archive)), file: 'release.zip' }
    await extractUpdateArchive(archive, join(directory, 'valid'), metadata)
    expect(await readFile(join(directory, 'valid', 'batond'), 'utf8')).toBe('offline zip package\n')
    const malformed = Buffer.from(
      Buffer.from(zipFixture, 'base64').toString('latin1').replaceAll('package/batond', '../escape/file'),
      'latin1',
    )
    await writeFile(archive, malformed)
    const target = join(directory, 'invalid')
    await expect(
      extractUpdateArchive(archive, target, { ...(await artifact(archive)), file: 'release.zip' }),
    ).rejects.toThrow('路径')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
