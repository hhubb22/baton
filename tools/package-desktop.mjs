import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildInfo, releaseVersion, validateReleaseMetadata } from './lib/release.mjs'
import { validateSeaVersion } from './package-release.mjs'

const desktopDirectory = fileURLToPath(new URL('../apps/desktop/', import.meta.url))

export function desktopTarget(version, platform = process.platform, arch = process.arch) {
  const appVersion = version === 'development' ? '0.0.0-development' : releaseVersion(version).slice(1)
  const prerelease = appVersion.split('-').slice(1).join('-')
  if (prerelease.split('.').some((part) => /^0\d+$/.test(part)))
    throw new Error('Electron 应用版本的数字预发布标识不能有前导零')
  const target = `${platform}-${arch}`
  const extension = { 'darwin-arm64': '.dmg', 'win32-x64': '.exe' }[target]
  if (!extension) throw new Error(`尚未支持的桌面平台：${target}`)
  return { target, appVersion, artifactName: `baton-desktop-${version}-${target}${extension}` }
}

export function desktopConfig({
  release,
  batond,
  output,
  appDirectory = desktopDirectory,
  electronVersion,
  platform = process.platform,
  arch = process.arch,
}) {
  buildInfo(release)
  if (release.platform !== platform || release.arch !== arch)
    throw new Error('batond 发布信息与桌面打包平台不匹配，请在目标平台重新构建')
  const { appVersion, artifactName } = desktopTarget(release.version, platform, arch)
  return {
    appId: 'dev.baton.desktop',
    productName: 'Baton',
    electronVersion,
    directories: { app: resolve(appDirectory), output: resolve(output) },
    extraMetadata: { version: appVersion, main: 'dist/main.cjs' },
    files: ['dist/main.cjs', 'dist/preload.cjs', 'dist/setup.html', 'package.json'],
    // builder 默认跳过每个输入根目录中的 node_modules，须单独列出该目录。
    extraResources: [
      { from: resolve(batond), to: 'batond', filter: ['**/*'] },
      { from: join(resolve(batond), 'node_modules'), to: 'batond/node_modules', filter: ['**/*'] },
      ...(platform === 'darwin'
        ? [
            {
              from: join(resolve(appDirectory), 'dist/notification-permission.node'),
              to: 'notification-permission.node',
            },
          ]
        : []),
    ],
    artifactName,
    asar: true,
    // batond 的原生依赖由独立 Node SEA 加载，保持其 Node ABI。
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    publish: null,
    protocols: [{ name: 'Baton 接入链接', schemes: ['baton'] }],
    mac: {
      target: [{ target: 'dmg', arch: ['arm64'] }],
      identity: '-',
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
      // 保留 SEA 和旁置原生依赖的签名，只给 Electron 应用做临时签名。
      signIgnore: ['[/\\\\]Resources[/\\\\]batond(?:[/\\\\]|$)'],
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: true,
      runAfterFinish: true,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
    },
  }
}

function runCommand(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const diagnostic = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} 执行失败：${result.signal ?? result.status}${diagnostic ? `\n${diagnostic}` : ''}`)
  }
  return result.stdout?.trim()
}

async function buildInstaller({ appDirectory, config, platform, arch }) {
  // 只在显式打包时加载 builder；安装依赖和导入本模块不下载 Electron。
  const require = createRequire(join(appDirectory, 'package.json'))
  const { build, Platform, Arch } = require('electron-builder')
  const target = platform === 'darwin' ? Platform.MAC : Platform.WINDOWS
  return build({
    projectDir: appDirectory,
    targets: target.createTarget(platform === 'darwin' ? 'dmg' : 'nsis', Arch[arch]),
    config: {
      ...config,
      ...(process.env.electron_config_cache ? { electronDownload: { cache: process.env.electron_config_cache } } : {}),
    },
  })
}

async function requireFile(path, executable = false) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0) throw new Error(`打包文件必须是非空普通文件：${path}`)
  if (executable && (info.mode & 0o111) === 0) throw new Error(`batond 缺少执行权限：${path}`)
}

export async function packageDesktop({
  batond,
  output,
  appDirectory = desktopDirectory,
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  builder = buildInstaller,
} = {}) {
  if (!batond || !output) throw new Error('用法：node tools/package-desktop.mjs --batond <目录> --out <目录>')
  batond = resolve(batond)
  output = resolve(output)
  appDirectory = resolve(appDirectory)
  const nested = relative(batond, output)
  if (nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))) {
    throw new Error('桌面产物目录不能位于 batond 安装目录内')
  }
  const release = JSON.parse(await readFile(join(batond, 'release.json'), 'utf8'))
  const app = JSON.parse(await readFile(join(appDirectory, 'package.json'), 'utf8'))
  const config = desktopConfig({
    release,
    batond,
    output,
    appDirectory,
    electronVersion: app.devDependencies?.electron ?? app.dependencies?.electron,
    platform,
    arch,
  })
  if (!config.electronVersion) throw new Error('apps/desktop/package.json 缺少 Electron 版本')
  const executable = join(batond, platform === 'win32' ? 'batond.exe' : 'batond')
  // Windows 文件系统没有 POSIX 执行位，宿主为 Windows 时不检查。
  await requireFile(executable, platform !== 'win32' && process.platform !== 'win32')
  const runtime = validateSeaVersion(
    run(executable, ['--version'], { capture: true, timeout: 30_000, cwd: batond }),
    platform,
    arch,
  )
  validateReleaseMetadata(release, runtime)
  if (release.runtime !== 'node-sea' || release.node !== runtime.node)
    throw new Error('batond 发布信息与 SEA 运行时不匹配')

  run(process.execPath, ['../../tools/build/desktop.mjs'], { cwd: appDirectory })
  for (const name of ['main.cjs', 'preload.cjs', 'setup.html']) await requireFile(join(appDirectory, 'dist', name))
  if (platform === 'darwin') await requireFile(join(appDirectory, 'dist', 'notification-permission.node'))
  await mkdir(output, { recursive: true })
  const artifacts = await builder({ appDirectory, config, platform, arch })
  const artifact = join(output, config.artifactName)
  if (!Array.isArray(artifacts) || !artifacts.some((path) => resolve(path) === artifact))
    throw new Error(`electron-builder 未生成预期安装包：${artifact}`)
  await requireFile(artifact)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(artifact)) hash.update(chunk)
  const sha256 = hash.digest('hex')
  await writeFile(artifact + '.sha256', `${sha256}  ${basename(artifact)}\n`)
  return { artifact, sha256, version: release.version, platform: `${platform}-${arch}` }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { batond: { type: 'string' }, out: { type: 'string' } } })
    console.log(JSON.stringify(await packageDesktop({ batond: values.batond, output: values.out }), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
