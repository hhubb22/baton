import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseVersion, validateReleaseMetadata } from './lib/release.mjs'
import { installedExecutable, isolatedEnv, validatePackageLayout } from './lib/installation.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export function releaseTarget(version, platform = process.platform, arch = process.arch) {
  releaseVersion(version)
  const target = {
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win-x64',
  }[`${platform}-${arch}`]
  if (!target) throw new Error(`尚未支持的发布平台：${platform}-${arch}`)
  const name = `baton-${version}-${target}`
  return { name, target, extension: platform === 'win32' ? '.zip' : '.tar.gz' }
}

export function archiveArgs(archive, staging, name, platform = process.platform) {
  return [platform === 'win32' ? '-acf' : '-czf', archive, '-C', staging, name]
}

export function validateSeaVersion(raw, platform = process.platform, arch = process.arch) {
  const info = JSON.parse(raw)
  if (info?.sea !== true) throw new Error('batond 必须是 Node SEA 安装包')
  if (info.platform !== platform || info.arch !== arch) throw new Error('SEA 与发布平台不匹配，请在目标平台重新构建')
  if (
    typeof info.node !== 'string' ||
    info.node !== info.node.trim() ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.node)
  )
    throw new Error('SEA 未报告有效的 Node 版本')
  return info
}

export function validatePackageManifest(raw, runtime) {
  const manifest = JSON.parse(raw)
  if (manifest?.format !== 'node-sea') throw new Error('安装包清单必须声明 node-sea 格式')
  for (const field of ['platform', 'arch', 'node']) {
    if (manifest[field] !== runtime[field]) throw new Error(`安装包清单与 SEA 的 ${field} 不匹配`)
  }
  validateReleaseMetadata(manifest.release, runtime)
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0)
    throw new Error('安装包清单缺少生产依赖')
  for (const dependency of manifest.dependencies) {
    if (['name', 'version', 'path'].some((field) => typeof dependency?.[field] !== 'string' || !dependency[field]))
      throw new Error('安装包清单的依赖需要 name、version 和 path')
  }
  return manifest
}

function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const diagnostic = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} 执行失败：${result.signal ?? result.status}${diagnostic ? `\n${diagnostic}` : ''}`)
  }
  return result.stdout?.trim()
}

// 允许检查失败时，check-package 的失败报告照常写出，归档仍然生成，供在目标平台上继续排查。
function runPackageCheck(installed, allowFailure) {
  const args = [join(root, 'tools/check-package.mjs'), installed]
  if (!allowFailure) return JSON.parse(run(process.execPath, args, { capture: true }))
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  const report = JSON.parse(result.stdout)
  if (result.status !== 0 || report.passed !== true) {
    const failed = Object.entries(report.checks ?? {}).filter(([, check]) => !check.passed)
    const detail = failed.map(([name, check]) => `${name}: ${check.message}`).join('\n') || report.failure?.message
    console.error(`安装包检查未通过，仍写出归档${detail ? `\n${detail}` : ''}`)
  }
  return report
}

async function checkCommands(binary, staging) {
  const home = join(staging, 'home')
  await mkdir(home)
  const options = { capture: true, cwd: home, env: isolatedEnv(home), timeout: 10_000 }
  if (!run(binary, ['--help'], options)) throw new Error('batond --help 输出为空')
  const version = run(binary, ['--version'], options)
  if (!version) throw new Error('batond --version 输出为空')
  return validateSeaVersion(version)
}

export async function packageRelease(
  version,
  source = resolve(root, 'bin'),
  output = resolve(root, 'bin/releases'),
  { allowCheckFailure = false } = {},
) {
  const { name, extension } = releaseTarget(version)
  await validatePackageLayout(source)
  const staging = await mkdtemp(join(tmpdir(), 'baton-release-'))
  const archive = join(staging, name + extension)
  const destination = resolve(output, name + extension)
  try {
    // 仅复制发布入口、依赖和许可，避免带入本地配置或构建中间文件。
    const payload = join(staging, name)
    await mkdir(payload)
    const binary = basename(installedExecutable(payload))
    for (const entry of [binary, 'node_modules', 'licenses', 'package.json', 'package-manifest.json', 'release.json'])
      await cp(join(source, entry), join(payload, entry), { recursive: true, verbatimSymlinks: true })
    for (const entry of ['INSTALL.md']) {
      const path = join(source, entry)
      const info = await lstat(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!info) continue
      if (!info.isFile()) throw new Error(`安装包元数据必须是普通文件：${entry}`)
      await cp(path, join(payload, entry))
    }
    const batondVersion = await checkCommands(join(payload, binary), staging)
    validatePackageManifest(await readFile(join(payload, 'package-manifest.json'), 'utf8'), batondVersion)
    const release = JSON.parse(await readFile(join(payload, 'release.json'), 'utf8'))
    validateReleaseMetadata(release, batondVersion, version)
    if (release.runtime !== 'node-sea' || release.node !== batondVersion.node)
      throw new Error('发布信息与 SEA 运行时不匹配')
    await mkdir(output, { recursive: true })
    // Windows 显式使用系统 bsdtar，避免 Git Bash 的 GNU tar 生成非 zip 文件。
    const tar = process.platform === 'win32' ? win32.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
    run(tar, archiveArgs(archive, staging, name))
    const contents = await readFile(archive)
    const magic = extension === '.zip' ? Buffer.from([0x50, 0x4b, 0x03, 0x04]) : Buffer.from([0x1f, 0x8b])
    if (!contents.subarray(0, magic.length).equals(magic)) throw new Error('压缩包内容格式与扩展名不匹配')

    // 验证最终解压产物，覆盖压缩过程中的权限、依赖和链接变化。
    const extracted = join(staging, 'extracted')
    await mkdir(extracted)
    run(tar, ['-xf', archive, '-C', extracted])
    const installed = join(extracted, name)
    await validatePackageLayout(installed)
    validatePackageManifest(await readFile(join(installed, 'package-manifest.json'), 'utf8'), batondVersion)
    const check = runPackageCheck(installed, allowCheckFailure)
    const metadata = JSON.parse(await readFile(join(installed, 'release.json'), 'utf8'))
    if (JSON.stringify(metadata) !== JSON.stringify(release)) throw new Error('解压后的发布信息不匹配')
    const checksum = createHash('sha256').update(contents).digest('hex')
    await cp(archive, destination)
    await writeFile(destination + '.sha256', `${checksum}  ${basename(destination)}\n`)
    await writeFile(resolve(output, `${name}.check.json`), JSON.stringify(check, null, 2) + '\n')
    console.log(JSON.stringify({ archive: destination, sha256: checksum, checkPassed: check.passed, ...release }))
    return destination
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'))
    const unknown = flags.filter((flag) => flag !== '--allow-check-failure')
    if (unknown.length) throw new Error(`未知参数：${unknown.join(' ')}`)
    const [version, source, output] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
    await packageRelease(version, source ? resolve(source) : undefined, output ? resolve(output) : undefined, {
      allowCheckFailure: flags.includes('--allow-check-failure'),
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
