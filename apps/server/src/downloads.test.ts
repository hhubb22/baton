import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { createDownloads, downloadsConfiguration } from './downloads.ts'
import { downloadArchive, writeChecksum } from './testing/downloads.ts'

it('returns unchanged release assets and rejects modified files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-download-'))
  try {
    const archive = await downloadArchive(directory)
    const windows = join(directory, 'baton-development-win-x64.zip')
    await writeFile(windows, 'windows archive')
    await writeChecksum(windows)
    const downloads = await createDownloads({ directory }, ['https://baton.local'])
    const listing = await downloads.list('baton.local')
    expect(listing.connect_url).toBe('baton://connect?url=https%3A%2F%2Fbaton.local')
    expect(listing.items.map((item) => item.file).sort()).toEqual([archive.file, 'baton-development-win-x64.zip'])
    const raw = await downloads.file('baton.local', archive.file)
    expect(await readFile(raw!.path)).toEqual(await readFile(archive.path))
    expect((await downloads.file('baton.local', 'baton-development-win-x64.zip'))?.item.platform).toBe('win32')
    await writeFile(archive.path, 'modified')
    expect(await downloads.file('baton.local', archive.file)).toBeUndefined()
    expect(await downloads.file('baton.local', '../secret')).toBeUndefined()
    await downloads.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('configures only the release directory and separately supplied public CA', () => {
  expect(downloadsConfiguration({ BATON_PUBLIC_CA_FILE: '/ca.pem' })).toBeUndefined()
  expect(downloadsConfiguration({ BATON_DOWNLOADS_DIR: '/packages', BATON_PUBLIC_CA_FILE: '/ca.pem' })).toEqual({
    directory: '/packages',
    caFile: '/ca.pem',
  })
})
