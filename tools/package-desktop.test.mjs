import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { releaseMetadata } from '../packages/protocol/src/release.mjs'
import { desktopConfig, desktopTarget, packageDesktop } from './package-desktop.mjs'

const version = 'v0.1.0-alpha.1'

function metadata(platform = 'darwin', arch = 'arm64', releaseVersion = version) {
  return {
    ...releaseMetadata(
      { version: releaseVersion, commit: releaseVersion === 'development' ? 'development' : 'a'.repeat(40) },
      platform,
      arch,
    ),
    runtime: 'node-sea',
    node: 'v26.11.1',
  }
}

for (const [platform, arch, extension] of [
  ['darwin', 'arm64', '.dmg'],
  ['win32', 'x64', '.exe'],
]) {
  test(`桌面安装包保留发布版本与平台名：${platform}-${arch}`, () => {
    for (const [releaseVersion, appVersion] of [
      [version, '0.1.0-alpha.1'],
      ['v1.2.3', '1.2.3'],
      ['development', '0.0.0-development'],
    ]) {
      assert.deepEqual(desktopTarget(releaseVersion, platform, arch), {
        target: `${platform}-${arch}`,
        appVersion,
        artifactName: `baton-desktop-${releaseVersion}-${platform}-${arch}${extension}`,
      })
    }
  })
}

test('拒绝非法版本、Electron 不接受的版本和未支持的平台', () => {
  for (const value of [undefined, null, '', '0.1.0', '../v1.2.3', 'v1.2.3\n', 'v1.2.3-alpha.01'])
    assert.throws(() => desktopTarget(value, 'darwin', 'arm64'))
  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
  ])
    assert.throws(() => desktopTarget(version, platform, arch), /尚未支持/)
})

test('打包配置保留完整 batond 资源、原生 ABI 与 macOS 临时签名', () => {
  const config = desktopConfig({
    release: metadata(),
    batond: '/tmp/batond input',
    output: '/tmp/desktop output',
    appDirectory: '/tmp/desktop',
    electronVersion: '44.5.1',
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.deepEqual(config.extraResources, [
    { from: resolve('/tmp/batond input'), to: 'batond', filter: ['**/*'] },
    { from: resolve('/tmp/batond input/node_modules'), to: 'batond/node_modules', filter: ['**/*'] },
    { from: resolve('/tmp/desktop/dist/notification-permission.node'), to: 'notification-permission.node' },
  ])
  assert.deepEqual(config.extraMetadata, { version: '0.1.0-alpha.1', main: 'dist/main.cjs' })
  assert.deepEqual(config.files, ['dist/main.cjs', 'dist/preload.cjs', 'dist/setup.html', 'package.json'])
  assert.equal(config.electronVersion, '44.5.1')
  assert.equal(config.npmRebuild, false)
  assert.equal(config.nodeGypRebuild, false)
  assert.equal(config.buildDependenciesFromSource, false)
  assert.equal(config.forceCodeSigning, Boolean(process.env.CSC_LINK))
  assert.equal(config.mac.hardenedRuntime, true)
  assert.deepEqual(config.mac.target, [
    { target: 'dmg', arch: ['arm64'] },
    { target: 'zip', arch: ['arm64'] },
  ])
  const ignored = (path) => config.mac.signIgnore.some((pattern) => new RegExp(pattern).test(path))
  for (const path of [
    '/out/Baton.app/Contents/Resources/batond/batond',
    '/out/Baton.app/Contents/Resources/batond/node_modules/native/addon.node',
    'C:\\out\\Baton.app\\Contents\\Resources\\batond\\batond',
  ])
    assert.equal(ignored(path), true)
  assert.equal(ignored('/out/Baton.app/Contents/MacOS/Baton'), false)
  assert.equal(ignored('/out/Baton.app/Contents/Resources/batond-other/file'), false)
})

test('Windows 只产出 x64 按用户安装的 NSIS，关闭提权和发布签名', () => {
  const config = desktopConfig({
    release: metadata('win32', 'x64'),
    batond: '/tmp/batond',
    output: '/tmp/out',
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(
    config.extraResources.some((entry) => entry.to === 'notification-permission.node'),
    false,
  )
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(config.win.signAndEditExecutable, Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK))
  assert.deepEqual(config.nsis, {
    oneClick: true,
    runAfterFinish: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
  })
  assert.equal(config.artifactName, `baton-desktop-${version}-win32-x64.\${ext}`)
})

async function fixture(t, { platform = 'darwin', arch = 'arm64', releaseVersion = version } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'baton-desktop-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const batond = join(directory, 'batond input')
  const appDirectory = join(directory, 'desktop app')
  const output = join(directory, 'desktop output')
  await mkdir(batond)
  await mkdir(join(appDirectory, 'dist'), { recursive: true })
  const release = metadata(platform, arch, releaseVersion)
  await writeFile(join(batond, 'release.json'), JSON.stringify(release))
  const executable = join(batond, platform === 'win32' ? 'batond.exe' : 'batond')
  await writeFile(executable, 'fixture executable', { mode: 0o755 })
  await writeFile(join(appDirectory, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.5.1' } }))
  for (const name of ['main.cjs', 'preload.cjs', 'setup.html']) await writeFile(join(appDirectory, 'dist', name), name)
  if (platform === 'darwin')
    await writeFile(join(appDirectory, 'dist', 'notification-permission.node'), 'permission module')
  const contents = Buffer.from('offline installer fixture')
  const calls = []
  const options = {
    batond,
    output,
    appDirectory,
    platform,
    arch,
    run(command, args, runOptions) {
      calls.push({ command, args, options: runOptions })
      if (command === executable) return JSON.stringify({ ...release, sea: true })
      return ''
    },
    async builder() {
      const artifact = join(output, desktopTarget(releaseVersion, platform, arch).artifactName)
      await writeFile(artifact, contents)
      return [artifact]
    },
  }
  return { options, release, executable, calls, contents }
}

for (const [platform, arch, releaseVersion] of [
  ['darwin', 'arm64', version],
  ['darwin', 'arm64', 'development'],
  ['win32', 'x64', version],
]) {
  test(`离线打包生成安装包和校验文件：${releaseVersion}-${platform}-${arch}`, async (t) => {
    const { options, calls, executable, contents } = await fixture(t, { platform, arch, releaseVersion })
    const result = await packageDesktop(options)
    const target = desktopTarget(releaseVersion, platform, arch)
    assert.equal(result.artifact, join(options.output, target.artifactName))
    assert.equal(result.version, releaseVersion)
    assert.equal(result.platform, `${platform}-${arch}`)
    assert.deepEqual(await readFile(result.artifact), contents)
    const hash = createHash('sha256').update(contents).digest('hex')
    assert.equal(result.sha256, hash)
    assert.equal(await readFile(result.artifact + '.sha256', 'utf8'), `${hash}  ${basename(result.artifact)}\n`)
    assert.equal(calls[0].command, executable)
    assert.deepEqual(calls[0].args, ['--binary-version'])
    assert.deepEqual(calls[1], {
      command: process.execPath,
      args: ['../../tools/build/desktop.mjs'],
      options: { cwd: options.appDirectory },
    })
    assert.equal(calls.length, 2)
  })
}

test('在构建前拒绝发布平台、版本、提交或运行时不一致', async (t) => {
  const { options, release } = await fixture(t)
  for (const change of [
    { platform: 'win32' },
    { arch: 'x64' },
    { version: 'v9.9.9' },
    { commit: 'b'.repeat(40) },
    { node: 'v26.0.0' },
    { sea: false },
  ]) {
    await assert.rejects(
      packageDesktop({
        ...options,
        run(command) {
          assert.notEqual(command, process.execPath)
          return JSON.stringify({ ...release, sea: true, ...change })
        },
        builder: () => assert.fail('invalid release reached builder'),
      }),
    )
  }
  for (const change of [{ platform: 'win32' }, { arch: 'x64' }, { version: '../invalid' }, { commit: 'short' }]) {
    await writeFile(join(options.batond, 'release.json'), JSON.stringify({ ...release, ...change }))
    await assert.rejects(packageDesktop({ ...options, run: () => assert.fail('invalid metadata reached runner') }))
  }
})

test('缺少、为空或无执行权限的 batond 在调用 runner 前失败', async (t) => {
  const { options, executable } = await fixture(t)
  const checked = { ...options, run: () => assert.fail('invalid executable reached runner') }
  if (process.platform !== 'win32') {
    await chmod(executable, 0o644)
    await assert.rejects(packageDesktop(checked), /执行权限/)
  }
  await writeFile(executable, '')
  await assert.rejects(packageDesktop(checked), /非空普通文件/)
  await rm(executable)
  await assert.rejects(packageDesktop(checked), /ENOENT/)
})

test('构建失败、缺少桌面 bundle 或 builder 失败均不产出校验文件', async (t) => {
  const { options } = await fixture(t)
  const failed = new Error('offline build failure')
  await assert.rejects(
    packageDesktop({
      ...options,
      run(command, ...args) {
        if (command === process.execPath) throw failed
        return options.run(command, ...args)
      },
    }),
    (error) => error === failed,
  )
  await assert.rejects(
    packageDesktop({ ...options, builder: () => Promise.reject(failed) }),
    (error) => error === failed,
  )
  await rm(join(options.appDirectory, 'dist/preload.cjs'))
  await assert.rejects(
    packageDesktop({ ...options, builder: () => assert.fail('missing bundle reached builder') }),
    /ENOENT/,
  )
  const artifact = join(options.output, desktopTarget(version, 'darwin', 'arm64').artifactName)
  await assert.rejects(readFile(artifact + '.sha256'), /ENOENT/)
})

test('builder 必须报告并写出非空安装包，不能用上次残留文件冒充成功', async (t) => {
  const { options } = await fixture(t)
  const artifact = join(options.output, desktopTarget(version, 'darwin', 'arm64').artifactName)
  for (const builder of [
    async () => [],
    async () => [artifact],
    async () => {
      await writeFile(artifact, '')
      return [artifact]
    },
    async () => {
      await writeFile(artifact, 'stale installer')
      return []
    },
  ])
    await assert.rejects(packageDesktop({ ...options, builder }))
  await assert.rejects(readFile(artifact + '.sha256'), /ENOENT/)
})

test('使用 builder 的实际复制器保留 batond 根目录中的 node_modules 与嵌套依赖', async (t) => {
  const { options, release } = await fixture(t)
  for (const file of ['node_modules/example/index.js', 'node_modules/example/node_modules/child/index.js']) {
    const path = join(options.batond, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, file)
  }
  const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'))
  const { getFileMatchers, copyFiles } = requireBuilder('app-builder-lib/out/fileMatcher.js')
  const config = desktopConfig({ ...options, release })
  const resources = join(options.output, 'resources')
  const matchers = getFileMatchers(config, 'extraResources', resources, {
    defaultSrc: options.appDirectory,
    customBuildOptions: {},
    globalOutDir: options.output,
    macroExpander: (value) => value,
  })
  await copyFiles(matchers)
  for (const file of [
    'release.json',
    'node_modules/example/index.js',
    'node_modules/example/node_modules/child/index.js',
  ])
    assert.deepEqual(await readFile(join(resources, 'batond', file)), await readFile(join(options.batond, file)))
})

test('CLI 必填参数和输出目录约束在构建前检查', async (t) => {
  await assert.rejects(packageDesktop(), /用法/)
  const { options } = await fixture(t)
  for (const output of [options.batond, join(options.batond, 'output')])
    await assert.rejects(packageDesktop({ ...options, output }), /不能位于 batond/)
})
