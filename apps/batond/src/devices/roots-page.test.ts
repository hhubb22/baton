import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowseRootsGetResult, NodeFrame, RuntimeReport, type RuntimeRoot } from '@baton/protocol'
import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makeDeviceService } from './index.ts'
import { boundRuntimeReport } from './report.ts'
import { readBrowseRootsPage } from './roots-page.ts'

it('reads every root across byte-bounded management pages and rejects changed lists', async () => {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'baton-roots-page-')))
  await ensurePrivateDirectory(data)
  const roots = Array.from({ length: 256 }, (_, index) => ({
    id: `root-${index}`,
    path: join(data, `${index}-${'目录\\"'.repeat(120)}`),
  }))
  const save = () => writePrivateFileAtomic(join(data, 'browse-roots.json'), JSON.stringify({ roots }))
  const service = await makeDeviceService({ dataDirectory: data })
  try {
    await save()
    const report = boundRuntimeReport({
      roots: roots.map((root) => ({ root_id: root.id, path: root.path })),
      repos: [],
      exec: { enabled: false, shell: '/bin/sh' },
    })
    expect(report.truncated).toBe(true)
    expect(report.roots?.length).toBeLessThan(roots.length)
    expect(Schema.is(RuntimeReport)(report)).toBe(true)
    const all: RuntimeRoot[] = []
    let cursor: string | undefined
    let firstCursor: string | undefined
    let pages = 0
    do {
      const operationId = randomUUID()
      const result = Schema.decodeUnknownSync(BrowseRootsGetResult)(
        await service.handle({
          type: 'node.browse_roots_get',
          operation_id: operationId,
          ...(cursor ? { cursor } : {}),
        }),
      )
      expect(result.ok).toBe(true)
      const page = result.page
      if (!page) throw new Error('Expected a roots page')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024)
      expect(
        Schema.is(NodeFrame)({
          kind: 'envelope',
          envelope: {
            version: 1,
            message_id: randomUUID(),
            route: { to: 'control' },
            priority: 'control',
            body: result,
          },
        }),
      ).toBe(true)
      all.push(...page.roots)
      cursor = page.next_cursor
      firstCursor ??= cursor
      pages++
    } while (cursor)
    expect(pages).toBeGreaterThan(1)
    expect(all).toEqual(roots.map((root) => ({ root_id: root.id, path: root.path })))
    if (!firstCursor) throw new Error('Expected a continuation cursor')
    await expect(readBrowseRootsPage(data, `${firstCursor}:extra`)).rejects.toMatchObject({
      code: 'invalid_request',
    })
    const updated = await service.handle({
      type: 'node.browse_roots_set',
      operation_id: randomUUID(),
      action: 'remove',
      path: 'root-255',
    })
    expect(updated).toMatchObject({ type: 'node.browse_roots_result', ok: true, truncated: true })
    expect(Buffer.byteLength(JSON.stringify(updated))).toBeLessThanOrEqual(64 * 1024)
    roots.pop()
    expect(
      await service.handle({
        type: 'node.browse_roots_get',
        operation_id: randomUUID(),
        cursor: firstCursor,
      }),
    ).toMatchObject({ ok: false, code: 'roots_changed' })
    roots.length = 0
    await save()
    expect(
      await service.handle({
        type: 'node.browse_roots_get',
        operation_id: randomUUID(),
      }),
    ).toMatchObject({ ok: true, page: { roots: [] } })
  } finally {
    await service.close()
    await rm(data, { recursive: true, force: true })
  }
})
