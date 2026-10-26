import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, copyFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function buildServer(output = join(repository, 'apps/server/dist/server.cjs')) {
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
    define: { 'import.meta.url': '__baton_import_meta_url__' },
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
  console.log(await buildServer(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
