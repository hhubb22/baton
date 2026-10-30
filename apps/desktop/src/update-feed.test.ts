import { expect, it, vi } from 'vite-plus/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { get } from 'node:http'
import { createLocalUpdateFeed, validateUpdateInfo } from './update-feed.ts'

vi.mock('electron-updater', () => ({ MacUpdater: class {}, NsisUpdater: class {} }))

it('serves the real GenericProvider cache-busted metadata request and rejects other hosts and paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-feed-'))
  const data =
    'version: 1.2.3\nfiles:\n  - url: package.zip\n    sha512: test\n    size: 1\npath: package.zip\nsha512: test\n'
  const path = join(directory, 'metadata')
  await writeFile(path, data)
  const feed = await createLocalUpdateFeed([{ file: 'latest-mac.yml', path, size: Buffer.byteLength(data) }])
  try {
    const require = createRequire(import.meta.url)
    const { GenericProvider } = require(
      join(dirname(require.resolve('electron-updater')), 'providers/GenericProvider.js'),
    )
    let requested = ''
    const executor = {
      request: (options: { path: string }) =>
        new Promise<string>((resolve, reject) => {
          requested = options.path
          get(new URL(options.path, feed.url), (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              body += chunk
            })
            response.on('end', () => resolve(body))
          }).on('error', reject)
        }),
    }
    const provider = new GenericProvider(
      { url: feed.url },
      { channel: 'latest', isAddNoCacheQuery: true },
      { platform: 'darwin', executor },
    )
    expect((await provider.getLatestVersion()).version).toBe('1.2.3')
    expect(requested).toMatch(/^\/latest-mac\.yml\?/)
    expect((await fetch(`${feed.url}/unknown?noCache=1`)).status).toBe(404)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(`${feed.url}/latest-mac.yml`, { headers: { host: 'example.com' } }, (response) => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject)
    })
    expect(status).toBe(404)
  } finally {
    feed.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('accepts the signed package in builder metadata and rejects redirected or mismatched assets', () => {
  const file = { file: 'baton-desktop-v1.2.3-darwin-arm64.zip', size: 123 }
  const info = {
    version: '1.2.3',
    path: file.file,
    files: [{ url: file.file, size: 123 }, { url: file.file.replace('.zip', '.dmg') }],
  }
  expect(() => validateUpdateInfo(info, 'v1.2.3', file, 'darwin')).not.toThrow()
  expect(() =>
    validateUpdateInfo(
      { ...info, files: [{ url: 'https://example.com/file.zip', size: 123 }] },
      'v1.2.3',
      file,
      'darwin',
    ),
  ).toThrow()
  expect(() =>
    validateUpdateInfo({ ...info, files: [{ url: file.file, size: 124 }] }, 'v1.2.3', file, 'darwin'),
  ).toThrow()
  expect(() => validateUpdateInfo(info, 'v1.2.4', file, 'darwin')).toThrow()
})
