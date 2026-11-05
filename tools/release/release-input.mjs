import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PROTOCOL_VERSION } from '../../packages/protocol/src/release.mjs'
import { buildInfo } from '../lib/release.mjs'

const present = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

export async function makeReleaseInput(directory, version, commit, { cliOnly = false } = {}) {
  buildInfo({ version, commit })
  const artifacts = [
    { kind: 'daemon', platform: 'darwin', arch: 'arm64', file: `baton-${version}-darwin-arm64.tar.gz` },
    { kind: 'daemon', platform: 'linux', arch: 'x64', file: `baton-${version}-linux-x64.tar.gz` },
    { kind: 'daemon', platform: 'linux', arch: 'arm64', file: `baton-${version}-linux-arm64.tar.gz` },
    { kind: 'daemon', platform: 'win32', arch: 'x64', file: `baton-${version}-win-x64.zip` },
  ]
  if (!cliOnly) {
    for (const entry of [
      { kind: 'desktop-manual', platform: 'darwin', arch: 'arm64', file: `baton-desktop-${version}-darwin-arm64.dmg` },
      { kind: 'desktop', platform: 'darwin', arch: 'arm64', file: `baton-desktop-${version}-darwin-arm64.zip` },
      { kind: 'desktop', platform: 'win32', arch: 'x64', file: `baton-desktop-${version}-win32-x64.exe` },
    ])
      if (await present(join(directory, entry.file))) artifacts.push(entry)
    if (artifacts.length === 4) throw new Error('桌面发布缺少安装包')
  }
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
        'cli-only': { type: 'boolean', default: false },
      },
    })
    if (!values.dir || !values.version || !values.commit || !values.out)
      throw new Error(
        '用法：node tools/release/release-input.mjs --dir <目录> --version <版本> --commit <提交> --out <输入文件>',
      )
    const input = await makeReleaseInput(values.dir, values.version, values.commit, {
      cliOnly: values['cli-only'],
    })
    await writeFile(values.out, JSON.stringify(input) + '\n')
  } catch (error) {
    console.error(error instanceof Error ? error.message : '发布输入无效')
    process.exitCode = 1
  }
}
