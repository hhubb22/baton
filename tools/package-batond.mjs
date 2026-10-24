import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const output = resolve(process.argv[2] ?? 'bin')
await mkdir(output, { recursive: true })
for (const name of ['batond']) {
  const result = spawnSync(
    'go',
    ['build', '-o', join(output, name + (process.platform === 'win32' ? '.exe' : '')), `./cmd/${name}`],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('Go 构建失败')
}
const install = spawnSync(
  'pnpm',
  ['--dir', 'runtimes/project-agent', 'install', '--frozen-lockfile', '--ignore-scripts'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)
if (install.error) throw install.error
if (install.status !== 0) throw new Error('Runtime 依赖安装失败')
const result = spawnSync(
  process.execPath,
  ['tools/package-sidecar.mjs', 'runtimes/project-agent', join(output, 'sidecars/project-agent'), 'project-agent'],
  { stdio: 'inherit' },
)
if (result.status !== 0) throw new Error('sidecar 打包失败')
