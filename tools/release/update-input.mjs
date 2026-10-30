import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PROTOCOL_VERSION } from '../../packages/protocol/src/release.mjs'
import { buildInfo } from '../lib/release.mjs'

export async function makeUpdateInput(
  directory,
  version,
  commit,
  { macAutoUpdate = false, windowsAutoUpdate = false, cliOnly = false } = {},
) {
  buildInfo({ version, commit })
  if (cliOnly && (macAutoUpdate || windowsAutoUpdate)) throw new Error('仅 CLI 发布不能声明桌面自动更新')
  const artifacts = [
    { kind: 'daemon', platform: 'darwin', arch: 'arm64', file: `baton-${version}-darwin-arm64.tar.gz` },
    { kind: 'daemon', platform: 'linux', arch: 'x64', file: `baton-${version}-linux-x64.tar.gz` },
    { kind: 'daemon', platform: 'linux', arch: 'arm64', file: `baton-${version}-linux-arm64.tar.gz` },
    { kind: 'daemon', platform: 'win32', arch: 'x64', file: `baton-${version}-win-x64.zip` },
    ...(cliOnly
      ? []
      : [
          {
            kind: 'desktop-manual',
            platform: 'darwin',
            arch: 'arm64',
            file: `baton-desktop-${version}-darwin-arm64.dmg`,
          },
        ]),
    ...(macAutoUpdate
      ? [
          { kind: 'desktop', platform: 'darwin', arch: 'arm64', file: `baton-desktop-${version}-darwin-arm64.zip` },
          { kind: 'desktop-feed', platform: 'darwin', arch: 'arm64', file: 'latest-mac.yml' },
        ]
      : []),
    ...(windowsAutoUpdate
      ? [
          { kind: 'desktop', platform: 'win32', arch: 'x64', file: `baton-desktop-${version}-win32-x64.exe` },
          { kind: 'desktop-feed', platform: 'win32', arch: 'x64', file: 'latest.yml' },
        ]
      : []),
  ]
  await Promise.all(artifacts.map((entry) => access(join(directory, entry.file))))
  const server_image = (await readFile(join(directory, 'server-image.txt'), 'utf8')).trim()
  if (!/^ghcr\.io\/hhubb22\/baton@sha256:[a-f0-9]{64}$/.test(server_image)) throw new Error('中心镜像摘要无效')
  return { version, commit, protocol_version: PROTOCOL_VERSION, server_image, artifacts }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        dir: { type: 'string' },
        version: { type: 'string' },
        commit: { type: 'string' },
        out: { type: 'string' },
        'mac-auto-update': { type: 'boolean', default: false },
        'windows-auto-update': { type: 'boolean', default: false },
        'cli-only': { type: 'boolean', default: false },
      },
    })
    if (!values.dir || !values.version || !values.commit || !values.out)
      throw new Error(
        '用法：node tools/release/update-input.mjs --dir <目录> --version <版本> --commit <提交> --out <输入文件>',
      )
    const input = await makeUpdateInput(values.dir, values.version, values.commit, {
      macAutoUpdate: values['mac-auto-update'],
      windowsAutoUpdate: values['windows-auto-update'],
      cliOnly: values['cli-only'],
    })
    await writeFile(values.out, JSON.stringify(input) + '\n')
  } catch (error) {
    console.error(error instanceof Error ? error.message : '发布输入无效')
    process.exitCode = 1
  }
}
