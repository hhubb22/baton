import { build } from 'esbuild'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function buildBatond(output = join(repository, 'apps/batond/dist/batond.cjs')) {
  await build({
    entryPoints: [join(repository, 'apps/batond/src/index.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    external: ['@cursor/sdk', '@cursor/sdk/*'],
    define: { 'import.meta.url': '__baton_import_meta_url__' },
    banner: { js: 'const __baton_import_meta_url__ = require("node:url").pathToFileURL(__filename).href;' },
    logLevel: 'silent',
  })
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildBatond(process.argv[2] ? resolve(process.argv[2]) : undefined))
}
