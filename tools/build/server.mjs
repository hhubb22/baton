import { build } from 'esbuild'
import { parseArgs } from 'node:util'
import { buildInfo } from '../lib/release.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, copyFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function buildServer(output = join(repository, 'apps/server/dist/server.cjs'), release = {}) {
  const identity = buildInfo(release)
  await promisify(execFile)(
    'pnpm',
    ['--dir', join(repository, 'web'), 'exec', 'vp', 'build', '--outDir', join(dirname(output), 'web')],
    // Windows 上 pnpm 是 pnpm.cmd，需要经 shell 启动。
    { cwd: repository, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' },
  )
  await build({
    entryPoints: [join(repository, 'apps/server/src/index.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    define: { 'import.meta.url': '__baton_import_meta_url__', __BATON_BUILD__: JSON.stringify(identity) },
    banner: { js: 'const __baton_import_meta_url__ = require("node:url").pathToFileURL(__filename).href;' },
    logLevel: 'silent',
  })
  const target = join(dirname(output), 'migrations')
  await mkdir(target, { recursive: true })
  for (const name of await readdir(join(repository, 'migrations'))) {
    if (/^\d+_[a-z_]+\.sql$/.test(name)) await copyFile(join(repository, 'migrations', name), join(target, name))
  }
  // Include the migration directory even when the bundle is launched from another working directory.
  await readFile(join(target, '0001_initial.sql'))
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: { version: { type: 'string' }, commit: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 1)
    throw new Error('用法：node tools/build/server.mjs [输出路径] [--version 版本 --commit 提交]')
  console.log(await buildServer(positionals[0] ? resolve(positionals[0]) : undefined, values))
}
