import { mkdir, mkdtemp, readFile, rm, cp, writeFile, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildBatond } from './ts-migration/build-batond.mjs'
import {
  bundledPackages,
  copyDependencyLicenses,
  copyProductionDependencies,
  packageDirectory,
} from './package-dependencies.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))

export async function nodeTarget(binary) {
  const data = await readFile(binary)
  let platform, arch
  if (data.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
    platform = 'darwin'
    arch = { 0x0100000c: 'arm64', 0x01000007: 'x64' }[data.readUInt32LE(4)]
  } else if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    platform = 'linux'
    arch = { 183: 'arm64', 62: 'x64' }[data.readUInt16LE(18)]
  } else if (data.subarray(0, 2).toString() === 'MZ') {
    platform = 'win32'
    arch = { 0x8664: 'x64', 0xaa64: 'arm64' }[data.readUInt16LE(data.readUInt32LE(0x3c) + 4)]
  }
  if (!platform || !arch) throw new Error(`无法识别 Node 可执行文件的系统和架构：${binary}`)
  return { platform, arch }
}

export async function packageBatond({ output = join(repository, 'bin'), node = process.execPath } = {}) {
  output = resolve(output)
  node = resolve(node)
  const target = await nodeTarget(node)
  const native = target.platform === process.platform && target.arch === process.arch
  const version = native
    ? execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
    : /node-v(\d+\.\d+\.\d+)-/.exec(node)?.[1]
  if (!version) throw new Error('交叉构建的 --node 必须指向 cache-node.mjs 缓存中的官方 Node')
  const nodeVersion = version.startsWith('v') ? version : `v${version}`
  const buildDirectory = await mkdtemp(join(tmpdir(), 'baton-sea-build-'))
  await mkdir(output, { recursive: true })
  try {
    const executable = join(output, target.platform === 'win32' ? 'batond.exe' : 'batond')
    let bundledDependencies
    const bundle = await buildBatond(join(buildDirectory, 'batond.cjs'), {
      onMetafile: async ({ inputs }) => {
        bundledDependencies = await bundledPackages(inputs, repository)
      },
    })
    const nativeSuffix = target.platform === 'linux' ? '-gnu' : target.platform === 'win32' ? '-msvc' : ''
    const seeds = [
      { name: '@cursor/sdk', from: join(repository, 'apps/batond') },
      { name: `@cursor/sdk-${target.platform}-${target.arch}`, from: join(repository, 'apps/batond') },
      { name: '@napi-rs/keyring', from: join(repository, 'upstream/t3code/packages/provider-cursor') },
      {
        name: `@napi-rs/keyring-${target.platform}-${target.arch}${nativeSuffix}`,
        from: await packageDirectory('@napi-rs/keyring', join(repository, 'upstream/t3code/packages/provider-cursor')),
      },
      { name: '@earendil-works/pi-ai', from: join(repository, 'runtimes/project-agent') },
      { name: '@earendil-works/pi-agent-core', from: join(repository, 'runtimes/project-agent') },
    ]
    const modules = join(output, 'node_modules')
    await rm(modules, { recursive: true, force: true })
    const dependencies = await copyProductionDependencies(seeds, modules, target)
    const config = join(buildDirectory, 'sea.json')
    await writeFile(
      config,
      JSON.stringify({
        main: bundle,
        output: executable,
        executable: node,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
        execArgvExtension: 'none',
      }),
    )
    // A native official Node can build itself; cross builds use the host Node with the cached target executable.
    try {
      execFileSync(native ? node : process.execPath, ['--build-sea', config], { stdio: 'pipe', timeout: 120_000 })
    } catch (error) {
      throw new Error(
        `SEA 构建失败，请使用支持 --build-sea 的官方 Node（可通过 --node 指定本地缓存）：${error.stderr?.toString() ?? error.message}`,
      )
    }
    await chmod(executable, 0o755)
    if (target.platform === 'darwin') {
      if (process.platform !== 'darwin') throw new Error('macOS 安装包必须在 macOS 上完成 ad-hoc 签名')
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], { stdio: 'pipe', timeout: 60_000 })
    }
    const licenses = join(output, 'licenses')
    await rm(licenses, { recursive: true, force: true })
    await copyDependencyLicenses([...dependencies, ...bundledDependencies], licenses)
    await cp(join(repository, 'third_party/cursor-sdk'), join(licenses, 'cursor-sdk'), { recursive: true })
    await cp(join(repository, 'upstream/t3code/LICENSE'), join(licenses, 't3code-LICENSE'))
    const nodeLicense = join(dirname(node), target.platform === 'win32' ? 'LICENSE' : '../LICENSE')
    try {
      await cp(nodeLicense, join(licenses, 'Node-LICENSE'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw new Error('官方 Node 旁缺少 LICENSE；请使用 cache-node.mjs 解包后的完整官方归档')
    }
    await cp(join(repository, 'runtimes/INSTALL.md'), join(output, 'INSTALL.md'))
    const metadata = {
      format: 'node-sea',
      ...target,
      node: nodeVersion,
      dependencies,
      bundledDependencies: bundledDependencies.map(({ name, version }) => ({ name, version })),
    }
    await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n')
    await writeFile(join(output, 'package-manifest.json'), JSON.stringify(metadata, null, 2) + '\n')
    return { ...metadata, executable, output }
  } finally {
    await rm(buildDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { out: { type: 'string' }, node: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 1)
    throw new Error('用法：node tools/package-batond.mjs [输出目录] [--out 目录] [--node 官方Node路径]')
  try {
    console.log(
      JSON.stringify(await packageBatond({ output: values.out ?? positionals[0], node: values.node }), null, 2),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
