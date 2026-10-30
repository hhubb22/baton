import { build } from 'esbuild'
import { parseArgs } from 'node:util'
import { buildInfo, updateKeys } from '../lib/release.mjs'
import { resolve, dirname, join, relative } from 'node:path'
import { packageDirectory } from '../package-dependencies.mjs'
import { fileURLToPath } from 'node:url'
import { assertWorkerDependencies } from './worker-dependencies.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const external = ['@cursor/sdk', '@cursor/sdk/*', '@napi-rs/keyring', '@aws-sdk/client-s3']

export async function buildBatond(
  output = join(repository, 'apps/batond/dist/batond.cjs'),
  { onMetafile, updateKeysFile, ...release } = {},
) {
  const identity = buildInfo(release)
  await assertWorkerDependencies({ external })
  const result = await build({
    entryPoints: [join(repository, 'apps/batond/src/index.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    external,
    plugins: [
      {
        name: 'disk-pi-modules',
        setup(builder) {
          builder.onResolve({ filter: /^@earendil-works\/pi-(ai|agent-core)(\/|$)/ }, async (args) => {
            if (args.pluginData?.diskPiResolution) return
            const result = await builder.resolve(args.path, {
              kind: 'import-statement',
              resolveDir: join(repository, 'runtimes/project-agent'),
              pluginData: { diskPiResolution: true },
            })
            if (result.errors.length) return { errors: result.errors }
            const name = args.path.split('/').slice(0, 2).join('/')
            const root = await packageDirectory(name, join(repository, 'runtimes/project-agent'))
            return {
              path: args.path,
              namespace: 'disk-pi',
              pluginData: {
                name,
                entry: relative(root, result.path).replaceAll('\\', '/'),
                developmentEntry: result.path,
              },
            }
          })
          builder.onLoad({ filter: /.*/, namespace: 'disk-pi' }, ({ pluginData }) => ({
            // Pi exposes import-only entrypoints. Load the resolved ESM file through Node's require(esm),
            // retaining its on-disk relative imports and model assets in both development and SEA builds.
            contents: `const entry = require('node:sea').isSea() ? require('node:path').join(require('node:path').dirname(process.execPath), 'node_modules', ${JSON.stringify(pluginData.name)}, ${JSON.stringify(pluginData.entry)}) : ${JSON.stringify(pluginData.developmentEntry)}; module.exports = require(entry);`,
            loader: 'js',
          }))
        },
      },
    ],
    define: {
      'import.meta.url': '__baton_import_meta_url__',
      __BATON_BUILD__: JSON.stringify(identity),
      __BATON_UPDATE_KEYS__: JSON.stringify(updateKeys(updateKeysFile)),
    },
    banner: {
      js: `require = require('node:module').createRequire(require('node:sea').isSea() ? require('node:path').join(require('node:path').dirname(process.execPath), 'package.json') : __filename);
const __baton_import_meta_url__ = require('node:url').pathToFileURL(__filename).href;`,
    },
    metafile: Boolean(onMetafile),
    logLevel: 'silent',
  })
  if (onMetafile) await onMetafile(result.metafile)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: { version: { type: 'string' }, commit: { type: 'string' }, 'update-keys': { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 1)
    throw new Error('用法：node tools/build/batond.mjs [输出路径] [--version 版本 --commit 提交]')
  console.log(
    await buildBatond(positionals[0] ? resolve(positionals[0]) : undefined, {
      ...values,
      updateKeysFile: values['update-keys'],
    }),
  )
}
