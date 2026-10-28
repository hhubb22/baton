import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { releaseMetadata } from '@baton/protocol/release'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'
import { createDownloads, downloadsConfiguration, injectDeployment, type Downloads } from './downloads.ts'
import { downloadArchive, downloadCA, tarCommand, writeChecksum } from './testing/downloads.ts'

const directories: string[] = []
const downloads: Downloads[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'baton-downloads-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(downloads.splice(0).map((value) => value.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('only configures downloads when a directory is provided', () => {
  expect(downloadsConfiguration({ BATON_PUBLIC_CA_FILE: '/ca.pem' })).toBeUndefined()
  expect(downloadsConfiguration({ BATON_DOWNLOADS_DIR: '/packages' })).toEqual({
    directory: '/packages',
    cacheDirectory: join(process.cwd(), 'downloads-cache'),
  })
  expect(
    downloadsConfiguration({
      BATON_DOWNLOADS_DIR: '/packages',
      BATON_DOWNLOADS_CACHE: '/cache',
      BATON_PUBLIC_CA_FILE: '/ca.pem',
    }),
  ).toEqual({ directory: '/packages', cacheDirectory: '/cache', caFile: '/ca.pem' })
})

it.each([undefined, 'ustar', 'gnu'] as const)(
  'injects deterministic deployment bytes while preserving original tar entries (%s)',
  async (format) => {
    // Windows 的 bsdtar 不支持 --format=gnu，也不产生 GNU 长文件名扩展（L/K），该用例无法在 Windows 验证。
    if (format === 'gnu' && process.platform === 'win32') return
    const directory = await fixture()
    const archive = await downloadArchive(directory, format ? { format } : {})
    const config = { format: 1 as const, coordinator_url: 'https://baton.local', ca_pem: 'public-test-ca' }
    const item = {
      kind: 'cli' as const,
      platform: 'linux' as const,
      arch: 'x64' as const,
      file: archive.file,
      size: 0,
      sha256: archive.hash,
    }
    const first = join(directory, 'first.tar.gz')
    const second = join(directory, 'second.tar.gz')
    await injectDeployment(archive.path, first, item, config)
    await injectDeployment(archive.path, second, item, config)
    const bytes = await readFile(first)
    expect(bytes.equals(await readFile(second))).toBe(true)
    expect(bytes.readUInt32LE(4)).toBe(0)
    const originalTar = gunzipSync(await readFile(archive.path))
    let end = 0
    const types: string[] = []
    while (!originalTar.subarray(end, end + 512).every((byte) => byte === 0)) {
      types.push(String.fromCharCode(originalTar[end + 156]))
      const size = Number.parseInt(
        originalTar
          .subarray(end + 124, end + 136)
          .toString()
          .replace(/\0.*$/, '')
          .trim(),
        8,
      )
      end += 512 + Math.ceil(size / 512) * 512
    }
    expect(gunzipSync(bytes).subarray(0, end)).toEqual(originalTar.subarray(0, end))
    if (format === 'gnu') expect(types).toEqual(expect.arrayContaining(['L', 'K']))
    if (!format && process.platform === 'darwin') {
      expect(types).toContain('x')
      expect(originalTar.includes(Buffer.from('._' + archive.name))).toBe(true)
    }
    const original = join(directory, 'original')
    const extracted = join(directory, 'extracted')
    for (const [destination, source] of [
      [original, archive.path],
      [extracted, first],
    ]) {
      await mkdir(destination)
      execFileSync(tarCommand(), ['-xf', source, '-C', destination])
    }
    const root = join(extracted, archive.name)
    expect(JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'))).toEqual(config)
    // Windows 不表达 POSIX 权限位，stat().mode 恒为 0666。
    if (process.platform !== 'win32') expect((await stat(join(root, 'deployment.json'))).mode & 0o777).toBe(0o644)
    expect((await stat(join(root, 'deployment.json'))).mtimeMs).toBe(
      Math.floor((await stat(join(root, 'release.json'))).mtimeMs / 1000) * 1000,
    )
    const originals = await readdir(original, { recursive: true })
    // readdir 在 Windows 返回反斜杠分隔的路径，拼接 deployment.json 时也要用同一分隔符。
    expect((await readdir(extracted, { recursive: true })).sort()).toEqual(
      [...originals, join(archive.name, 'deployment.json')].sort(),
    )
    for (const file of originals) {
      const before = await stat(join(original, file))
      if (!before.isFile()) continue
      const after = await stat(join(extracted, file))
      expect(await readFile(join(extracted, file))).toEqual(await readFile(join(original, file)))
      expect(after.mode & 0o777).toBe(before.mode & 0o777)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    }
  },
)

it('filters incomplete, unsupported and malformed packages and reuses per-origin caches after restart', async () => {
  const directory = await fixture()
  const packages = join(directory, 'packages')
  const cache = join(directory, 'cache')
  await mkdir(packages)
  const archive = await downloadArchive(packages)
  await downloadArchive(packages, { version: 'v-old' })
  await downloadArchive(packages, { platform: 'linux', arch: 'arm64', root: 'wrong-root' })
  await downloadArchive(packages, { platform: 'darwin', arch: 'arm64', metadata: { platform: 'linux' } })
  const desktop = join(packages, 'baton-desktop-development-darwin-arm64.dmg')
  await writeFile(desktop, 'desktop unchanged')
  await writeChecksum(desktop)
  await writeFile(join(packages, 'baton-desktop-development-win32-x64.exe'), 'missing checksum')
  const bad = join(packages, 'baton-v-bad-linux-x64.tar.gz')
  await writeFile(bad, 'invalid')
  await writeFile(bad + '.sha256', '0'.repeat(64))
  const caFile = downloadCA(directory)
  const ca = new X509Certificate(await readFile(caFile))
  const reasons: string[] = []
  const options = { directory: packages, cacheDirectory: cache, caFile }
  const origins = ['https://baton.local', 'https://other.local:8443']
  const server = await createDownloads(
    options,
    origins,
    {
      ...releaseMetadata(),
      supported_daemon_versions: ['development', 'v-bad'],
    },
    (entry) => reasons.push(entry.reason),
  )
  downloads.push(server)
  await expect
    .poll(async () => ({ files: (await server.list('baton.local')).items.map((item) => item.file), reasons }))
    .toMatchObject({ files: expect.arrayContaining([archive.file]) })
  const listing = await server.list('baton.local')
  expect(listing.connect_url).toBe(`baton://connect?url=https%3A%2F%2Fbaton.local&ca=${ca.raw.toString('base64url')}`)
  expect(listing.ca_sha256).toBe(createHash('sha256').update(ca.raw).digest('hex'))
  const output = await server.file('baton.local', archive.file)
  expect(output).toBeDefined()
  expect(output!.item.sha256).toBe(
    createHash('sha256')
      .update(await readFile(output!.path))
      .digest('hex'),
  )
  // Windows 不表达 POSIX 权限位。
  if (process.platform !== 'win32') expect((await stat(cache)).mode & 0o777).toBe(0o700)
  await expect
    .poll(async () => ({ files: (await server.list('other.local:8443')).items.map((item) => item.file), reasons }))
    .toMatchObject({ files: expect.arrayContaining([archive.file]) })
  const other = await server.file('other.local:8443', archive.file)
  expect(other!.item.sha256).not.toBe(output!.item.sha256)
  const desktopOutput = await server.file('unknown.local', 'baton-desktop-development-darwin-arm64.dmg')
  expect(await readFile(desktopOutput!.path, 'utf8')).toBe('desktop unchanged')
  expect(await server.list('unknown.local')).toMatchObject({
    connect_url: null,
    items: [expect.objectContaining({ kind: 'desktop' })],
  })
  expect(reasons.join('\n')).toContain('中心不接受该版本')
  expect(reasons.join('\n')).toContain('SHA-256 不符')
  expect(reasons.join('\n')).toContain('顶层目录不符')
  expect(reasons.join('\n')).toContain('版本或平台不符')
  await server.close()
  const restarted = await createDownloads(options, origins)
  downloads.push(restarted)
  await expect.poll(async () => (await restarted.list('baton.local')).items.length).toBe(2)
  expect((await restarted.file('baton.local', archive.file))!.item).toEqual(output!.item)
  await writeFile(archive.path, 'changed in place')
  expect((await restarted.list('baton.local')).items.map((item) => item.file)).not.toContain(archive.file)
  await restarted.close()
  expect((await readdir(cache)).some((file) => file.endsWith('.tmp'))).toBe(false)
})

it('retries the same package and deployment after a background injection failure', async () => {
  const directory = await fixture()
  const archive = await downloadArchive(directory)
  let attempts = 0
  let rejected!: () => void
  const failed = new Promise<void>((resolve) => {
    rejected = resolve
  })
  const server = await createDownloads(
    { directory, cacheDirectory: join(directory, 'cache') },
    ['https://baton.local'],
    releaseMetadata(),
    (entry) => {
      if (entry.event === 'download_rejected') rejected()
    },
    async (...args) => {
      attempts++
      if (attempts === 1) throw new Error('temporary write failure')
      await injectDeployment(...args)
    },
  )
  downloads.push(server)
  await failed
  await expect
    .poll(async () => (await server.list('baton.local')).items.map((item) => item.file))
    .toEqual([archive.file])
  expect(attempts).toBe(2)
})
