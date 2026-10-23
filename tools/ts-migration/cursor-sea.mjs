import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { dependencyRequire, buildSea, environment, isolatedEnv } from './common.mjs'

const dependencies = dependencyRequire()
const { build } = dependencies('esbuild')
const sdkRoot = dirname(dependencies.resolve('@cursor/sdk')).replace(/[/\\]dist[/\\]cjs$/, '')
const modules = dirname(dirname(sdkRoot))
const platformPackage = `sdk-${process.platform}-${process.arch}`
const platformRoot = join(modules, '@cursor', platformPackage)
const root = mkdtempSync(join(tmpdir(), 'baton-cursor-sea-'))
const metadata = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
if (metadata.version !== '1.0.35') throw new Error(`Expected @cursor/sdk 1.0.35; got ${metadata.version}`)
const source = `
  const { createRequire } = require('node:module');
  const { dirname, join } = require('node:path');
  const { execFileSync } = require('node:child_process');
  const nativeRequire = createRequire(join(dirname(process.execPath), 'package.json'));
  globalThis.fetch = () => { throw new Error('Network is disabled in the packaging probe'); };
  const http = require('node:http');
  const https = require('node:https');
  http.request = https.request = http.get = https.get = () => { throw new Error('Network is disabled in the packaging probe'); };
  async function main() {
    const { Agent } = require('@cursor/sdk');
    const { SqliteLocalAgentStore } = require('@cursor/sdk/sqlite');
    if (typeof Agent.create !== 'function' || typeof Agent.resume !== 'function') throw new Error('SDK API missing');
    const store = await SqliteLocalAgentStore.open({ workspaceRef: process.cwd(), stateRoot: join(process.cwd(), 'state') });
    await store.dispose();
    const platform = join(dirname(process.execPath), 'node_modules', '@cursor', 'sdk-' + process.platform + '-' + process.arch);
    const Parser = nativeRequire(join(platform, 'vendor/tree-sitter'));
    const Bash = nativeRequire(join(platform, 'vendor/tree-sitter-bash'));
    const parser = new Parser();
    parser.setLanguage(Bash);
    const tree = parser.parse('echo baton');
    const treeType = tree.rootNode.type;
    const rg = execFileSync(join(platform, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'), ['--version'], { encoding: 'utf8', timeout: 5000 }).split('\\n')[0];
    console.log(JSON.stringify({ sdkImport: true, sqliteStore: true, treeSitter: treeType, ripgrep: rg, node: process.version, modelCalls: 0 }));
  }
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
`
const results = []
try {
  for (const variant of [
    'bundled',
    'bundled-with-platform',
    'flat-bundled',
    'flat-bundled-with-platform',
    'external-sdk',
  ]) {
    const directory = join(root, variant)
    const home = join(directory, 'empty-home')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const bundle = join(root, `${variant}.cjs`)
    let buildResult
    try {
      buildResult = await build({
        stdin: {
          contents:
            variant === 'external-sdk'
              ? source.replaceAll("require('@cursor/sdk", "nativeRequire('@cursor/sdk")
              : variant.startsWith('flat-')
                ? source.replaceAll("require('@cursor/sdk", "require('@cursor/sdk/bundled")
                : source,
          resolveDir: modules,
          sourcefile: 'cursor-probe.cjs',
        },
        bundle: true,
        platform: 'node',
        target: 'node26',
        format: 'cjs',
        outfile: bundle,
        external: variant === 'external-sdk' ? ['@cursor/sdk', '@cursor/sdk/*'] : ['bun:*'],
        logLevel: 'silent',
        metafile: true,
      })
    } catch (error) {
      const errors = error.errors?.map(({ text }) => text) ?? [error.message]
      results.push({ variant, build: false, errorCount: errors.length, errors: errors.slice(0, 8) })
      continue
    }
    const executable = join(directory, process.platform === 'win32' ? 'batond.exe' : 'batond')
    await buildSea(bundle, executable)
    if (variant.endsWith('with-platform'))
      cpSync(platformRoot, join(directory, 'node_modules/@cursor', platformPackage), { recursive: true })
    if (variant === 'external-sdk') {
      // Copy the SDK's published production dependency groups.
      for (const group of ['@cursor', '@bufbuild', '@connectrpc', '@statsig', 'zod']) {
        cpSync(join(modules, group), join(directory, 'node_modules', group), { recursive: true })
      }
    }
    const run = spawnSync(executable, [], {
      cwd: home,
      env: isolatedEnv(home),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    const result = {
      variant,
      build: true,
      bundledInputFiles: Object.keys(buildResult.metafile.inputs).length,
      status: run.status,
      signal: run.signal,
      stdout: run.stdout?.trim(),
      stderr: run.stderr?.slice(0, 5000),
      error: run.error?.message,
    }
    if (variant === 'external-sdk' && run.status === 0) {
      const moved = join(directory, 'node_modules.removed')
      const { renameSync } = await import('node:fs')
      renameSync(join(directory, 'node_modules'), moved)
      const missing = spawnSync(executable, [], {
        cwd: home,
        env: isolatedEnv(home),
        encoding: 'utf8',
        timeout: 10_000,
      })
      result.missingSidecarRejected = missing.status !== 0 && /Cannot find module/.test(missing.stderr)
    }
    results.push(result)
  }
  const sandboxPath = join(platformRoot, 'bin', process.platform === 'win32' ? 'cursorsandbox.exe' : 'cursorsandbox')
  let sandbox
  if (existsSync(sandboxPath)) {
    const home = join(root, 'sandbox-home')
    mkdirSync(home)
    try {
      sandbox = {
        present: true,
        loaded: true,
        help: execFileSync(sandboxPath, ['--help'], {
          cwd: home,
          env: isolatedEnv(home),
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 5000,
        }).slice(0, 1000),
      }
    } catch (error) {
      sandbox = { present: true, loaded: false, status: error.status, error: error.message.slice(0, 1000) }
    }
  } else sandbox = { present: false, loaded: false }
  const external = results.find(({ variant }) => variant === 'external-sdk')
  const packagingPassed = external?.status === 0 && external.missingSidecarRejected && sandbox.loaded
  console.log(
    JSON.stringify(
      {
        ...environment(),
        sdk: metadata.version,
        engines: metadata.engines,
        license: metadata.license,
        platformPackage,
        installScripts: 'not run',
        scope:
          'Offline package import, isolated SQLite store, native tree-sitter parsing and ripgrep; no Agent.create/resume/send, credentials or model calls. Sandbox --help checks loading only.',
        sandbox,
        packagingPassed,
        results,
      },
      null,
      2,
    ),
  )
  if (!packagingPassed) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
