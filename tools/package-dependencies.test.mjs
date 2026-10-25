import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { bundledPackages, copyProductionDependencies, matchesTarget } from './package-dependencies.mjs'

const target = { platform: 'linux', arch: 'arm64' }

test('production dependencies preserve conflicting versions, cycles and optional platform selection after relocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baton-dependencies-'))
  async function fixture(path, metadata, value = metadata.version) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ main: 'index.cjs', ...metadata }))
    await writeFile(join(path, 'index.cjs'), `module.exports = ${JSON.stringify(value)}`)
  }
  try {
    const source = join(root, 'source')
    await fixture(source, { name: 'fixture', version: '1' })
    const modules = join(source, 'node_modules')
    await fixture(join(modules, 'a'), { name: 'a', version: '1', dependencies: { shared: '1', b: '1' } })
    await fixture(join(modules, 'b'), {
      name: 'b',
      version: '1',
      dependencies: { shared: '2', a: '1' },
      optionalDependencies: { missing: '1', darwin: '1' },
    })
    await fixture(join(modules, 'shared'), { name: 'shared', version: '1' })
    await fixture(join(modules, 'b/node_modules/shared'), { name: 'shared', version: '2' })
    await fixture(join(modules, 'darwin'), { name: 'darwin', version: '1', os: ['darwin'], cpu: ['arm64'] })
    const installed = join(root, 'installed/node_modules')
    const copied = await copyProductionDependencies([{ name: 'a', from: source }], installed, target)
    await rm(source, { recursive: true })
    const aRequire = createRequire(join(installed, 'a/package.json'))
    const bRequire = createRequire(join(installed, 'b/package.json'))
    assert.equal(aRequire('shared'), '1')
    assert.equal(bRequire('shared'), '2')
    assert.equal(bRequire('a'), '1')
    assert.deepEqual(copied.map(({ name, version }) => `${name}@${version}`).sort(), [
      'a@1',
      'b@1',
      'shared@1',
      'shared@2',
    ])
    assert.equal(JSON.parse(await readFile(join(installed, 'b/package.json'), 'utf8')).version, '1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing required dependencies stop packaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baton-dependencies-'))
  try {
    const path = join(root, 'source/node_modules/a')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'a', dependencies: { absent: '1' } }))
    await assert.rejects(
      copyProductionDependencies(
        [{ name: 'a', from: join(root, 'source') }],
        join(root, 'installed/node_modules'),
        target,
      ),
      /缺少安装包依赖 absent/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bundled licenses belong to the named package above module-format marker files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baton-licenses-'))
  try {
    const directory = join(root, 'node_modules/example/dist')
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1' }))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    assert.deepEqual(await bundledPackages({ 'node_modules/example/dist/index.js': {} }, root), [
      {
        name: 'example',
        version: '1',
        path: join(root, 'node_modules/example'),
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('target selection honors positive and negative os/cpu/libc constraints', () => {
  assert.equal(matchesTarget({ os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }, target), true)
  assert.equal(matchesTarget({ os: ['!linux'] }, target), false)
  assert.equal(matchesTarget({ cpu: ['x64'] }, target), false)
  assert.equal(matchesTarget({ libc: ['musl'] }, target), false)
})
