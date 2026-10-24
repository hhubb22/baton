import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { scanRuntimeRoots } from './scan.ts'
import { boundedDirectory } from './files.ts'

it('reports every registered root after the repository scan exhausts its shared budget', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'baton-roots-report-')))
  try {
    const data = join(directory, 'data')
    await ensurePrivateDirectory(data)
    const roots = [
      { id: 'home', path: join(directory, 'home') },
      { id: 'workspace', path: join(directory, 'workspace') },
    ]
    for (const root of roots) await mkdir(root.path)
    await writePrivateFileAtomic(join(data, 'browse-roots.json'), JSON.stringify({ roots }))
    const budget = new AbortController()
    budget.abort()
    const report = await scanRuntimeRoots(data, budget.signal)
    expect(report).toEqual({
      roots: roots.map((root) => ({ root_id: root.id, path: root.path })),
      repos: [],
      truncated: true,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'counts omitted directory names against the repository scan budget',
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'baton-scan-budget-')))
    try {
      for (const name of ['omitted:a', 'omitted:b', 'omitted:c']) await writeFile(join(directory, name), '')
      const listing = await boundedDirectory({ id: 'workspace', path: directory }, '', 2)
      expect(listing).toEqual({ names: [], limited: true, scanned: 2 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
