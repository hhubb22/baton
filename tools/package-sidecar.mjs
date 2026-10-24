// 固定版本 Node sidecar 与 batond 同目录分发；程序和依赖使用同一份锁文件。
import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { resolve, join, basename, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'

const [sourceArg, outputArg, name] = process.argv.slice(2)
if (!sourceArg || !outputArg || !/^[a-z0-9-]+$/.test(name ?? ''))
  throw new Error('用法：node tools/package-sidecar.mjs <源码目录> <输出目录> <sidecar 名称>')
const source = resolve(sourceArg),
  output = resolve(outputArg)
const under = (parent, child) => {
  const path = relative(parent, child)
  return !path || (!path.startsWith('..') && !isAbsolute(path))
}
if (under(source, output) || under(output, source)) throw new Error('源码与输出目录必须相互独立')
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
function run(args, cwd) {
  const result = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error('sidecar 构建失败')
}
run(['build'], source)
await mkdir(output, { recursive: true })
await rm(join(output, 'dist'), { recursive: true, force: true })
await rm(join(output, 'node_modules'), { recursive: true, force: true })
for (const file of ['dist', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
  await cp(join(source, file), join(output, file), { recursive: true })
run(['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--node-linker=hoisted'], output)
const bins = Object.entries(pkg.bin ?? {})
if (bins.length !== 1) throw new Error('sidecar 必须有一个 CLI 入口')
const [, entry] = bins[0]
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify({ name, version: pkg.version, protocol: 1, entry }, null, 2) + '\n',
)
await chmod(join(output, entry), 0o755)
console.log(`sidecar ${name}@${pkg.version}: ${basename(output)}`)
