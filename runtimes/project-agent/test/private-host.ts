import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
export const privateFileHostCommand = {
  file: process.execPath,
  args: [
    '--import',
    tsxLoader,
    fileURLToPath(new URL('../../../apps/batond/src/platform/private-file-host-entry.ts', import.meta.url)),
  ],
}
