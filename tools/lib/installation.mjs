import { cp, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function environment() {
  return { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model }
}

// Probe children receive no provider credentials or personal configuration paths.
export function isolatedEnv(home) {
  const env = { HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, PATH: '', NO_COLOR: '1' }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

export function installedExecutable(installed, platform = process.platform) {
  return join(installed, platform === 'win32' ? 'batond.exe' : 'batond')
}

export async function withTemporaryInstallation(source, use) {
  if (!source) throw new Error('An installation directory is required')
  // Short paths keep Darwin UDS endpoints below 103 bytes.
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bw-'))
  const installed = join(root, 'installed')
  try {
    await cp(resolve(source), installed, { recursive: true, verbatimSymlinks: true })
    const executable = await validatePackageLayout(installed)
    return await use({ root, installed, executable })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function validatePackageLayout(directory, platform = process.platform) {
  const packageRoot = await realpath(directory)
  const binary = installedExecutable(packageRoot, platform)
  const executable = await lstat(binary)
  if (!executable.isFile() || executable.size === 0) throw new Error('安装包缺少 batond 可执行文件')
  if (platform !== 'win32' && !(executable.mode & 0o111)) throw new Error('batond 缺少执行权限')
  for (const name of ['node_modules', 'licenses']) {
    const path = join(packageRoot, name)
    if (!(await lstat(path)).isDirectory() || !(await readdir(path)).length)
      throw new Error(`安装包缺少完整的 ${name} 目录`)
  }
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = relative(packageRoot, await realpath(path))
        if (target === '..' || target.startsWith('../') || target.startsWith('..\\') || isAbsolute(target))
          throw new Error(`安装包链接指向包外：${relative(packageRoot, path)}`)
      } else if (entry.isDirectory()) await checkLinks(path)
      else if (!entry.isFile()) throw new Error(`安装包包含非普通文件：${relative(packageRoot, path)}`)
    }
  }
  await checkLinks(packageRoot)
  return binary
}
