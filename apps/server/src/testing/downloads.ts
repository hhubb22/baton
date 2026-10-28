import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { releaseMetadata } from '@baton/protocol/release'

/**
 * Windows 上 Git 的 GNU tar 会把 `C:\...` 的盘符当作 POSIX 的远程主机语法（host:path），
 * 报 Cannot execute remote shell。与 tools/package-release.mjs 一致，显式使用系统 bsdtar。
 */
export function tarCommand(): string {
  return process.platform === 'win32'
    ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

export async function writeChecksum(path: string) {
  const content = await readFile(path)
  const hash = createHash('sha256').update(content).digest('hex')
  await writeFile(path + '.sha256', hash + '\n')
  return hash
}

export async function downloadArchive(
  directory: string,
  {
    version = 'development',
    platform = 'linux',
    arch = 'x64',
    root,
    metadata = {},
    format,
  }: {
    version?: string
    platform?: string
    arch?: string
    root?: string
    metadata?: Record<string, unknown>
    format?: 'ustar' | 'gnu'
  } = {},
) {
  const name = `baton-${version}-${platform}-${arch}`
  const staging = join(directory, 'staging')
  await rm(staging, { recursive: true, force: true })
  const packageDirectory = join(staging, root ?? name)
  await mkdir(join(packageDirectory, 'node_modules', 'fixture'), { recursive: true })
  await writeFile(join(packageDirectory, 'batond'), '#!/bin/sh\necho fixture\n')
  await chmod(join(packageDirectory, 'batond'), 0o755)
  await writeFile(join(packageDirectory, 'node_modules', 'fixture', 'index.js'), 'module.exports = 42\n')
  await writeFile(
    join(packageDirectory, 'release.json'),
    JSON.stringify({ ...releaseMetadata(), version, platform, arch, ...metadata }),
  )
  if (format !== 'ustar') {
    const longName = 'module-' + 'a'.repeat(120) + '.js'
    await writeFile(join(packageDirectory, 'node_modules', 'fixture', longName), 'long-name fixture\n')
    await symlink(longName, join(packageDirectory, 'node_modules', 'fixture', 'linked.js'))
  }
  const path = join(directory, name + '.tar.gz')
  // 默认参数与 tools/package-release.mjs 的非 Windows 发布归档一致。
  execFileSync(tarCommand(), [
    ...(format ? [`--format=${format === 'gnu' && process.platform === 'darwin' ? 'gnutar' : format}`] : []),
    '-czf',
    path,
    '-C',
    staging,
    root ?? name,
  ])
  const hash = await writeChecksum(path)
  return { name, file: name + '.tar.gz', path, hash, packageDirectory }
}

// 仅在临时目录中生成本地 CA，私钥随测试目录清理。
export function downloadCA(directory: string) {
  const path = join(directory, 'ca.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Baton downloads test',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      join(directory, 'ca.key'),
      '-out',
      path,
    ],
    { stdio: 'pipe' },
  )
  return path
}
