import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'apps/desktop/dist')
await mkdir(output, { recursive: true })
await build({
  entryPoints: {
    main: join(root, 'apps/desktop/src/main.ts'),
    preload: join(root, 'apps/desktop/src/preload.ts'),
  },
  outdir: output,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
})
await cp(join(root, 'apps/desktop/src/setup.html'), join(output, 'setup.html'))
