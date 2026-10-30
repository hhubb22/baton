import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vite-plus/test'
import { readProcessLock, processLockIsHeld } from '../platform/lock.ts'
import { readProcessIdentity, reapProcessTree } from '../platform/process.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { initializeWorkerDirectory, LocalWorkerHost } from './host.ts'
import { requestWorker } from './ipc.ts'

it('SDK 和 host driver 加载即抛错的实际 CLI bundle 中 Worker 仍通过 IPC 认证就绪', async () => {
  const directory = await makePrivateTempDirectory('bw-')
  const threadId = randomUUID()
  const paths = await initializeWorkerDirectory(directory, threadId)
  const bundle = join(directory, 'batond.cjs')
  let worker: Awaited<ReturnType<typeof readProcessIdentity>> = null
  try {
    const runtimePackage = fileURLToPath(new URL('../../../../runtimes/project-agent/package.json', import.meta.url))
    await build({
      entryPoints: [fileURLToPath(new URL('../index.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node26',
      format: 'cjs',
      external: [
        '@cursor/sdk',
        '@napi-rs/keyring',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-agent-core',
        '@aws-sdk/client-s3',
      ],
      define: { 'import.meta.url': '__baton_import_meta_url__' },
      banner: {
        js: `require = require('node:module').createRequire(${JSON.stringify(runtimePackage)});
const __baton_import_meta_url__ = require('node:url').pathToFileURL(__filename).href;`,
      },
      plugins: [
        {
          name: 'fail-on-sdk-or-driver-load',
          setup(builder) {
            builder.onLoad({ filter: /[/\\](?:sdk-loader|host-driver)\.ts$/ }, ({ path }) => ({
              contents: `throw new Error(${JSON.stringify(`Worker loaded ${path}`)}); module.exports = {};`,
              loader: 'js',
            }))
          },
        },
      ],
      logLevel: 'silent',
    })
    // 同一 bundle 的 host 分支确实会触发加载失败。
    await expect(promisify(execFile)(process.execPath, [bundle, 'agent-host', '--probe'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('installation_incomplete'),
    })
    const host = new LocalWorkerHost(directory, { executable: process.execPath, args: [bundle] })
    const status = await host.request(threadId, { type: 'status', ok: false }, { start: true })
    expect(status).toMatchObject({
      ok: true,
      worker_ready: true,
      agent_ready: false,
      release: { version: 'development', commit: 'development' },
    })
    expect(status.pid).toBeGreaterThan(1)
    worker = await readProcessIdentity(status.pid!)
    expect(worker).not.toBeNull()
    await expect(
      requestWorker({
        endpoint: paths.endpoint,
        token: '0'.repeat(64),
        request: { type: 'status', ok: false },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
  } catch (error) {
    const log = await readFile(paths.log, 'utf8').catch(() => '')
    throw new Error(`Worker bundle regression failed\n${log}`, { cause: error })
  } finally {
    worker ??= await readProcessLock(paths.lock)
    try {
      if (worker) {
        expect(await reapProcessTree(worker)).toEqual({ reaped: true })
        expect(await readProcessIdentity(worker.pid)).toBeNull()
        expect(await processLockIsHeld(paths.lock)).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 30_000)
