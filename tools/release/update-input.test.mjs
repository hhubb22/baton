import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeUpdateInput } from './update-input.mjs'

void test('collects all CLI targets and only opted-in desktop feeds with a pinned image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-update-input-'))
  const version = 'v1.2.3',
    commit = 'a'.repeat(40)
  try {
    await writeFile(join(dir, 'server-image.txt'), `ghcr.io/hhubb22/baton@sha256:${'b'.repeat(64)}\n`)
    for (const name of [
      `baton-${version}-darwin-arm64.tar.gz`,
      `baton-${version}-linux-x64.tar.gz`,
      `baton-${version}-linux-arm64.tar.gz`,
      `baton-${version}-win-x64.zip`,
      `baton-desktop-${version}-darwin-arm64.dmg`,
      `baton-desktop-${version}-win32-x64.exe`,
      'latest.yml',
    ])
      await writeFile(join(dir, name), 'fixture')
    const cliOnly = await makeUpdateInput(dir, version, commit)
    assert.equal(cliOnly.artifacts.length, 5)
    assert.equal(cliOnly.server_image, `ghcr.io/hhubb22/baton@sha256:${'b'.repeat(64)}`)
    assert.equal((await makeUpdateInput(dir, version, commit, { windowsAutoUpdate: true })).artifacts.length, 7)
    await rm(join(dir, `baton-desktop-${version}-darwin-arm64.dmg`))
    assert.equal((await makeUpdateInput(dir, version, commit, { cliOnly: true })).artifacts.length, 4)
    await assert.rejects(makeUpdateInput(dir, version, commit, { cliOnly: true, windowsAutoUpdate: true }))
    await assert.rejects(makeUpdateInput(dir, version, commit, { macAutoUpdate: true }))
    await writeFile(join(dir, 'server-image.txt'), 'ghcr.io/other/image@sha256:' + 'b'.repeat(64))
    await assert.rejects(makeUpdateInput(dir, version, commit, { cliOnly: true }), /中心镜像摘要无效/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
