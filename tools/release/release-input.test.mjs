import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeReleaseInput } from './release-input.mjs'

void test('collects CLI targets and published desktop installers with a pinned image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-release-input-'))
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
      `baton-desktop-${version}-darwin-arm64.zip`,
      `baton-desktop-${version}-win32-x64.exe`,
    ])
      await writeFile(join(dir, name), 'fixture')
    const input = await makeReleaseInput(dir, version, commit)
    assert.equal(input.artifacts.length, 7)
    assert.equal(input.server_image, `ghcr.io/hhubb22/baton@sha256:${'b'.repeat(64)}`)
    assert.equal((await makeReleaseInput(dir, version, commit, { cliOnly: true })).artifacts.length, 4)
    await rm(join(dir, `baton-desktop-${version}-darwin-arm64.dmg`))
    assert.equal((await makeReleaseInput(dir, version, commit)).artifacts.length, 6)
    await rm(join(dir, `baton-desktop-${version}-darwin-arm64.zip`))
    await rm(join(dir, `baton-desktop-${version}-win32-x64.exe`))
    await assert.rejects(makeReleaseInput(dir, version, commit), /桌面发布缺少安装包/)
    await writeFile(join(dir, 'server-image.txt'), 'ghcr.io/other/image@sha256:' + 'b'.repeat(64))
    await assert.rejects(makeReleaseInput(dir, version, commit, { cliOnly: true }), /中心镜像摘要无效/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
