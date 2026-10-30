import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { releaseMetadata } from '../packages/protocol/src/release.mjs'
import { buildInfo, validateReleaseMetadata } from './lib/release.mjs'
import {
  archiveArgs,
  archiveEnvironment,
  releaseTarget,
  validatePackageManifest,
  validateSeaVersion,
} from './package-release.mjs'
import { validatePackageLayout, withTemporaryInstallation } from './lib/installation.mjs'

const version = 'v0.1.0-alpha.1'

test('archive creation suppresses macOS metadata while retaining the process environment', () => {
  assert.deepEqual(archiveEnvironment({ PATH: '/bin' }), { PATH: '/bin', COPYFILE_DISABLE: '1' })
})

for (const [platform, arch, target, extension] of [
  ['linux', 'x64', 'linux-x64', '.tar.gz'],
  ['linux', 'arm64', 'linux-arm64', '.tar.gz'],
  ['darwin', 'arm64', 'darwin-arm64', '.tar.gz'],
  ['win32', 'x64', 'win-x64', '.zip'],
]) {
  test(`发布包按原生平台命名：${target}`, () => {
    assert.deepEqual(releaseTarget(version, platform, arch), {
      name: `baton-${version}-${target}`,
      target,
      extension,
    })
  })
}

test('SEA 必须报告原生目标与内置 Node，开发入口不能作为发布包', () => {
  const info = { sea: true, platform: 'linux', arch: 'arm64', node: 'v26.11.1' }
  assert.deepEqual(validateSeaVersion(JSON.stringify(info), 'linux', 'arm64'), info)
  assert.throws(() => validateSeaVersion(JSON.stringify(info), 'linux', 'x64'), /平台不匹配/)
  assert.throws(() => validateSeaVersion(JSON.stringify(info), 'darwin', 'arm64'), /平台不匹配/)
  for (const sea of [false, undefined, 'true'])
    assert.throws(() => validateSeaVersion(JSON.stringify({ ...info, sea }), 'linux', 'arm64'), /Node SEA/)
  for (const node of [undefined, '', '26.11.1', 'v26.11.1\n'])
    assert.throws(() => validateSeaVersion(JSON.stringify({ ...info, node }), 'linux', 'arm64'), /Node 版本/)
  assert.throws(() => validateSeaVersion('v26.11.1'), SyntaxError)
})

test('安装包清单与 SEA 的实际系统、架构和 Node 一致，并携带依赖来源', () => {
  const release = releaseMetadata({ version, commit: 'a'.repeat(40) }, 'darwin', 'arm64')
  const runtime = { ...release, sea: true, node: 'v26.11.1' }
  const manifest = {
    format: 'node-sea',
    release,
    platform: runtime.platform,
    arch: runtime.arch,
    node: runtime.node,
    dependencies: [{ name: '@cursor/sdk', version: '1.0.35', path: 'node_modules/@cursor/sdk' }],
  }
  assert.deepEqual(validatePackageManifest(JSON.stringify(manifest), runtime), manifest)
  for (const field of ['format', 'platform', 'arch', 'node'])
    assert.throws(() => validatePackageManifest(JSON.stringify({ ...manifest, [field]: 'wrong' }), runtime))
  for (const dependencies of [undefined, [], [{}]])
    assert.throws(() => validatePackageManifest(JSON.stringify({ ...manifest, dependencies }), runtime), /依赖/)
})

test('发布身份完整指定，元数据和程序不符或为旧程序重新贴标时拒绝发布', () => {
  assert.deepEqual(buildInfo(), { version: 'development', commit: 'development' })
  const identity = { version, commit: 'a'.repeat(40) }
  assert.deepEqual(buildInfo(identity), identity)
  for (const input of [
    { version },
    { commit: identity.commit },
    { ...identity, commit: 'abc' },
    { ...identity, commit: identity.commit + '\n' },
  ])
    assert.throws(() => buildInfo(input))
  const actual = releaseMetadata(identity, 'linux', 'x64')
  assert.deepEqual(validateReleaseMetadata({ ...actual }, actual, version), actual)
  assert.throws(() => validateReleaseMetadata(actual, actual, 'v0.2.0'), /重新贴标/)
  for (const field of Object.keys(actual)) {
    assert.throws(() => validateReleaseMetadata({ ...actual, [field]: 'wrong' }, actual), /不匹配/)
    const missing = { ...actual }
    delete missing[field]
    assert.throws(() => validateReleaseMetadata(missing, actual))
  }
})

test('版本输入拒绝路径、命令及不完整版本号', () => {
  for (const value of [
    undefined,
    null,
    123,
    '',
    '0.1.0',
    'v0.1',
    'v01.1.0',
    'v0.1.0-alpha/1',
    'v0.1.0;echo secret',
    '../v0.1.0',
    'v0.1.0\n',
    'v0.1.0\r\n',
    'v0.1.0-' + 'a'.repeat(128),
  ])
    assert.throws(() => releaseTarget(value, 'linux', 'x64'))
})

test('不把未支持的架构标成已有发布平台', () => {
  for (const [platform, arch] of [
    ['linux', 'ia32'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ])
    assert.throws(() => releaseTarget(version, platform, arch), /尚未支持/)
})

test('压缩包命令将路径作为独立参数传递，Windows 由扩展名选择 zip', () => {
  assert.deepEqual(archiveArgs('/out/package.tar.gz', '/tmp/with spaces', 'payload', 'darwin'), [
    '-czf',
    '/out/package.tar.gz',
    '-C',
    '/tmp/with spaces',
    'payload',
  ])
  assert.deepEqual(archiveArgs('C:\\out\\package.zip', 'C:\\temp folder', 'payload', 'win32'), [
    '-acf',
    'C:\\out\\package.zip',
    '-C',
    'C:\\temp folder',
    'payload',
  ])
})

async function layoutFixture(t, platform = process.platform) {
  const directory = await mkdtemp(join(tmpdir(), 'baton-release-layout-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binary = join(directory, platform === 'win32' ? 'batond.exe' : 'batond')
  await writeFile(binary, 'layout fixture', { mode: 0o755 })
  await mkdir(join(directory, 'node_modules'))
  await writeFile(join(directory, 'node_modules/package.json'), '{}')
  await mkdir(join(directory, 'licenses'))
  await writeFile(join(directory, 'licenses/LICENSE'), 'fixture license')
  return { directory, binary }
}

test('安装包结构要求原生文件名、依赖与许可目录', async (t) => {
  for (const platform of process.platform === 'win32' ? ['win32'] : ['linux', 'win32']) {
    const { directory, binary } = await layoutFixture(t, platform)
    assert.equal(await validatePackageLayout(directory, platform), await realpath(binary))
    await rm(binary)
    await assert.rejects(validatePackageLayout(directory, platform), /ENOENT/)
  }
})

test('缺少或清空附带目录时拒绝归档', async (t) => {
  for (const entry of ['node_modules', 'licenses']) {
    const { directory } = await layoutFixture(t)
    const path = join(directory, entry)
    await rm(path, { recursive: true })
    await assert.rejects(validatePackageLayout(directory), /ENOENT/)
    await mkdir(path)
    await assert.rejects(validatePackageLayout(directory), new RegExp(entry))
  }
})

test('空程序和丢失执行权限的程序不能发布', async (t) => {
  const { directory, binary } = await layoutFixture(t)
  await writeFile(binary, '')
  await assert.rejects(validatePackageLayout(directory), /可执行文件/)
  if (process.platform !== 'win32') {
    await writeFile(binary, 'layout fixture')
    await chmod(binary, 0o644)
    await assert.rejects(validatePackageLayout(directory), /执行权限/)
  }
})

test('搬迁安装包通过布局检查，使用完毕或回调失败后删除临时目录', async (t) => {
  const { directory } = await layoutFixture(t)
  if (process.platform !== 'win32') await symlink('../licenses', join(directory, 'node_modules/linked-license'), 'dir')
  let temporary
  const failure = new Error('fixture callback failure')
  for (const fail of [false, true]) {
    const use = withTemporaryInstallation(directory, async ({ root, installed, executable }) => {
      temporary = root
      assert.notEqual(installed, directory)
      assert.equal(await validatePackageLayout(installed), executable)
      if (fail) throw failure
      return 'used'
    })
    if (fail) await assert.rejects(use, (error) => error === failure)
    else assert.equal(await use, 'used')
    await assert.rejects(realpath(temporary), /ENOENT/)
  }
})

test('搬迁安装包在调用回调前拒绝包外链接', async (t) => {
  const { directory } = await layoutFixture(t)
  await symlink(tmpdir(), join(directory, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(
    withTemporaryInstallation(directory, () => assert.fail('invalid installation reached callback')),
    /指向包外/,
  )
})

test('附带目录中的链接必须在安装包内且目标存在', async (t) => {
  const { directory } = await layoutFixture(t)
  const link = join(directory, 'node_modules/linked-license')
  // Windows 的目录 junction 不要求开发者模式或创建符号链接权限。
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(directory, 'licenses'), link, linkType)
  await validatePackageLayout(directory)
  await rm(link)
  await symlink(tmpdir(), link, linkType)
  await assert.rejects(validatePackageLayout(directory), /指向包外/)
  await rm(link)
  await symlink(join(directory, 'missing'), link, linkType)
  await assert.rejects(validatePackageLayout(directory), /ENOENT/)
})
