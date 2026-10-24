import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import * as Schema from 'effect/Schema'

const requireCursorSdk = createRequire(isSea() ? join(dirname(process.execPath), 'package.json') : import.meta.url)
const PackageMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  engines: Schema.optional(Schema.Struct({ node: Schema.String })),
})
const metadata = (path: string) => Schema.decodeUnknownSync(PackageMetadata)(JSON.parse(readFileSync(path, 'utf8')))

/** Resolves installed metadata and assets without loading or executing the SDK. */
export function inspectCursorSdk() {
  const entryPath = requireCursorSdk.resolve('@cursor/sdk')
  let packageRoot = dirname(entryPath)
  while (true) {
    const candidate = join(packageRoot, 'package.json')
    if (existsSync(candidate)) {
      const name = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.optional(Schema.String) }))(
        JSON.parse(readFileSync(candidate, 'utf8')),
      ).name
      if (name === '@cursor/sdk') break
    }
    const parent = dirname(packageRoot)
    if (parent === packageRoot) throw new Error('Cursor SDK package metadata is missing')
    packageRoot = parent
  }
  const sdk = metadata(join(packageRoot, 'package.json'))
  const platformPackageName = `@cursor/sdk-${process.platform}-${process.arch}`
  const resolveFromSdk = createRequire(entryPath)
  const platformMetadataPath = resolveFromSdk.resolve(`${platformPackageName}/package.json`)
  const platformRoot = dirname(platformMetadataPath)
  const platform = metadata(platformMetadataPath)
  const assets = {
    sandboxHelper: join(platformRoot, 'bin', process.platform === 'win32' ? 'cursorsandbox.exe' : 'cursorsandbox'),
    rg: join(platformRoot, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
    treeSitter: join(platformRoot, 'vendor', 'tree-sitter'),
    treeSitterBash: join(platformRoot, 'vendor', 'tree-sitter-bash'),
  }
  const requiredFiles = [
    assets.sandboxHelper,
    assets.rg,
    join(assets.treeSitter, 'index.js'),
    join(assets.treeSitter, 'binding.node'),
    join(assets.treeSitterBash, 'index.js'),
    join(assets.treeSitterBash, 'binding.node'),
  ]
  return {
    version: sdk.version,
    nodeRange: sdk.engines?.node,
    entryPath,
    packageRoot,
    platformPackageName,
    platformVersion: platform.version,
    platformRoot,
    ...assets,
    missingAssets: requiredFiles.filter((path) => !existsSync(path)),
  }
}
