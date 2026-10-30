import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePackageManifest } from './package-release.mjs'
import { validateReleaseMetadata } from './lib/release.mjs'
import { environment, isolatedEnv, withTemporaryInstallation } from './lib/installation.mjs'
import { measureWorkerStartup } from './measure/worker-startup.mjs'
import { scanTelemetryArtifacts } from './lib/telemetry-scan.mjs'

function run(executable, args, options) {
  const result = spawnSync(executable, args, {
    ...options,
    encoding: 'utf8',
    // Windows runner 上进程启动和 PowerShell 调用明显更慢。
    timeout: process.platform === 'win32' ? 60_000 : 15_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, `${args.join(' ')} terminated by ${result.signal}`)
  return result
}

async function executionWorkerHandshake(executable, root, options) {
  const id = randomUUID()
  const data = join(root, 'execution-check')
  const directory = join(data, 'executions', id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(join(data, 'ipc'), { mode: 0o700 })
  const token = 'a'.repeat(64)
  await writeFile(join(directory, 'ipc.token'), token, { mode: 0o600 })
  const hash = createHash('sha256').update(`${data}\0execution\0${id}`).digest('hex').slice(0, 24)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\baton-${hash}` : join(data, 'ipc', `${hash}.sock`)
  const child = spawn(executable, ['execution-worker', '--data-dir', data, '--execution-id', id], {
    ...options,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  let spawnFailure
  child.once('error', (error) => {
    spawnFailure = error
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString().slice(0, 4096)
  })
  const poll = () =>
    new Promise((resolve, reject) => {
      const socket = createConnection(endpoint)
      let buffer = '',
        authenticated = false
      socket.setTimeout(1000, () => socket.destroy(new Error('IPC timeout')))
      socket.once('error', reject)
      socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', ok: false, token })}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const value = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (!authenticated) {
          if (!value.ok) {
            socket.destroy()
            reject(new Error('Execution IPC authentication failed'))
            return
          }
          authenticated = true
          socket.write(`${JSON.stringify({ type: 'execution.poll' })}\n`)
        } else {
          socket.destroy()
          resolve(value)
        }
      })
    })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (spawnFailure) throw spawnFailure
      if (child.exitCode !== null) throw new Error(`Execution Worker exited: ${stderr}`)
      try {
        const response = await poll()
        assert.equal(response.type, 'execution.response')
        assert.deepEqual(response.reports, [])
        return { authenticated: true }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`Execution Worker IPC did not become ready: ${stderr}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      if (child.exitCode !== null || spawnFailure) resolve()
      else child.once('exit', resolve)
    })
  }
}

async function runtimeHandshake(executable, options, mode = 'run') {
  const memory = mode.startsWith('memory')
  const cancelling = mode === 'memory-cancel'
  const operations = memory
    ? ['memory_bootstrap', 'pending_embeddings', ...(cancelling ? [] : ['finish'])]
    : ['bootstrap', 'read_events', 'claim_inputs']
  const observed = []
  let child, cancellationFailure
  let requests = 0,
    requestClosed = false
  // 本地端点保留请求，直到 stdio 关闭触发后台取消。
  const server = cancelling
    ? createServer((request, response) => {
        response.on('close', () => {
          requestClosed = true
        })
        request.resume()
        request.on('end', () => {
          try {
            requests++
            assert.equal(request.url, '/v1/embeddings')
            assert.equal(request.headers.authorization, 'Bearer package-check-embedding')
            child.stdin.end()
          } catch (error) {
            cancellationFailure = error
            child.kill('SIGKILL')
          }
        })
      })
    : undefined
  if (server)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  return new Promise((resolveHandshake, reject) => {
    child = spawn(executable, ['project-runtime', memory ? 'memory' : 'run'], {
      ...options,
      env: { ...options.env, BATON_PROJECT_RUNTIME_TRANSPORT: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let pending = ''
    let stderr = ''
    let failure
    const fail = (error) => {
      failure ??= error
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => fail(new Error('Project Runtime handshake timed out')), 15_000)
    child.once('error', (error) => {
      failure ??= error
    })
    child.stdin.on('error', fail)
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 64 * 1024) fail(new Error('Project Runtime stderr exceeded limit'))
    })
    child.stdout.on('data', (chunk) => {
      pending += chunk
      try {
        if (Buffer.byteLength(pending) > 192 * 1024) throw new Error('Project Runtime frame exceeded limit')
        let newline
        while ((newline = pending.indexOf('\n')) !== -1) {
          const frame = JSON.parse(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          assert.equal(frame.id, observed.length + 1, 'Invalid Project Runtime request ID')
          assert.equal(frame.request?.operation, operations[observed.length], 'Unexpected Project Runtime request')
          observed.push(frame.request.operation)
          let result
          if (frame.request.operation === 'memory_bootstrap') {
            result = {
              type: 'project_runtime.result',
              ok: true,
              data: {
                job_id: 'package-memory',
                kind: 'embedding',
                provider: 'unused',
                model: 'unused',
                max_model_calls: 8,
                max_duration_ms: 300000,
                max_changes: 16,
                cursor_index: 0,
                cursor_offset: 0,
              },
            }
          } else if (frame.request.operation === 'pending_embeddings') {
            result = {
              type: 'project_runtime.result',
              ok: true,
              data: cancelling
                ? {
                    memory_embedding: {
                      base_url: `http://127.0.0.1:${server.address().port}/v1`,
                      model: 'package-check',
                      config_id: 'package-check',
                      credential_profile: 'package-check',
                    },
                    entries: [
                      {
                        item_id: 'package-check',
                        revision: 1,
                        config_id: 'package-check',
                        embedding_text_hash: 'package-check',
                        text: 'Local cancellation check',
                      },
                    ],
                  }
                : { memory_embedding: null, entries: [] },
            }
          } else if (memory && frame.request.operation === 'finish') {
            result = { type: 'project_runtime.result', ok: true, data: {} }
          } else if (frame.request.operation === 'bootstrap') {
            result = {
              type: 'project_runtime.result',
              ok: true,
              data: {
                project: {
                  memory_embedding: null,
                  title: 'Package check',
                  goal: '',
                  agent: { provider: 'openai-codex', model: 'package-check-unused' },
                  conversation: { id: 'package-check' },
                },
                prompt_version: 'package-check',
                input_seq: 0,
                memory_settings: { core_tokens: 1500, related_tokens: 3500, max_bytes: 40960 },
                after_seq: 0,
                last_seq: 0,
              },
            }
          } else if (frame.request.operation === 'read_events') {
            assert.equal(frame.request.after_seq, 0)
            result = {
              type: 'project_runtime.result',
              ok: true,
              data: { events: [], last_seq: 0, next_after_seq: 0, has_more: false },
            }
          } else {
            assert.equal(frame.request.last_seq, 0)
            // The coordinator ends this offline handshake before any input or model call.
            result = { type: 'project_runtime.result', ok: false, code: 'package_check_complete' }
          }
          child.stdin.write(JSON.stringify({ id: frame.id, result }) + '\n')
          if (!cancelling && observed.length === operations.length) child.stdin.end()
        }
      } catch (error) {
        fail(error)
      }
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        if (failure || cancellationFailure) throw failure ?? cancellationFailure
        assert.deepEqual(observed, operations, `Incomplete Project Runtime handshake: ${stderr}`)
        assert.equal(pending, '')
        assert.equal(signal, null)
        assert.equal(code, memory ? 0 : 1, `Runtime must exit after the coordinator's completion response: ${stderr}`)
        if (cancelling) {
          assert.equal(requests, 1, '后台取消检查只允许一个本地 Embedding 请求')
          assert.equal(requestClosed, true, '后台退出后 Embedding 请求仍未关闭')
        }
        resolveHandshake({
          operations: observed,
          modelCalls: 0,
          ...(cancelling ? { localEmbeddingRequests: requests, requestClosed } : {}),
          exitCode: code,
          shutdown: cancelling ? 'stdio closed during local embedding request' : 'coordinator completion response',
        })
      } catch (error) {
        reject(error)
      }
    })
  }).finally(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  const usage = 'Usage: node tools/check-package.mjs [installation=bin] [--prepared driver-directory]'
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return
  }
  const preparedIndex = args.indexOf('--prepared')
  let preparedDirectory
  if (preparedIndex !== -1) {
    const value = args[preparedIndex + 1]
    assert.ok(value && !value.startsWith('--'), usage)
    preparedDirectory = resolve(value)
    args.splice(preparedIndex, 2)
  }
  assert.ok(args.length <= 1 && !args[0]?.startsWith('--'), usage)
  const report = { ...environment(), passed: false, checks: {} }
  async function check(name, action) {
    try {
      report.checks[name] = { passed: true, ...(await action()) }
    } catch (error) {
      report.checks[name] = { passed: false, message: error.message }
    }
  }
  await withTemporaryInstallation(args[0] ?? 'bin', async ({ root, installed, executable }) => {
    const home = join(root, 'home')
    await mkdir(home, { mode: 0o700 })
    const options = { cwd: home, env: isolatedEnv(home) }
    await check('telemetryConfigurationLeak', () =>
      scanTelemetryArtifacts([installed, resolve('apps/server/dist/web')]),
    )
    await check('help', () => {
      const result = run(executable, ['--help'], options)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Baton/i)
      assert.match(result.stdout, /register/)
      return { exitCode: result.status }
    })
    await check('version', () => {
      const result = run(executable, ['--binary-version'], options)
      assert.equal(result.status, 0, result.stderr)
      const version = JSON.parse(result.stdout)
      assert.equal(version.sea, true)
      assert.equal(version.platform, process.platform)
      assert.equal(version.arch, process.arch)
      assert.match(version.node, /^v\d+\.\d+\.\d+/)
      report.runtime = version
      return version
    })
    await check('updateModules', async () => {
      const directory = join(root, 'update-data')
      await mkdir(directory, { mode: 0o700 })
      const result = run(executable, ['update', 'policy', '--data-dir', directory], options)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).policy, 'manual')
      return { policy: 'manual' }
    })
    await check('releaseMetadata', async () => {
      const metadata = JSON.parse(await readFile(join(installed, 'release.json'), 'utf8'))
      validateReleaseMetadata(metadata, report.runtime)
      assert.equal(metadata.runtime, 'node-sea')
      assert.equal(metadata.node, report.runtime.node)
      validatePackageManifest(await readFile(join(installed, 'package-manifest.json'), 'utf8'), report.runtime)
      for (const role of ['worker', 'execution-worker', 'agent-host', 'watchdog', 'project-runtime']) {
        const result = run(executable, [role, '--version'], options)
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), report.runtime, `${role} 发布信息不匹配`)
      }
      const probe = run(executable, ['project-runtime', 'probe'], options)
      assert.equal(probe.status, 0, probe.stderr)
      const runtime = JSON.parse(probe.stdout)
      assert.equal(runtime.version, report.runtime.version)
      validateReleaseMetadata(runtime.release, report.runtime)
      return {
        ...metadata,
        childProcesses: ['worker', 'execution-worker', 'agent-host', 'watchdog', 'project-runtime'],
      }
    })
    await check('worker', async () => {
      const result = await measureWorkerStartup({ root, installed, samples: 1, preparedDirectory })
      assert.equal(result.passed, true, JSON.stringify(result.failure ?? result))
      validateReleaseMetadata(result.ledger.release, report.runtime)
      return result
    })
    await check('executionWorker', () => executionWorkerHandshake(executable, root, options))
    await check('agentHost', () => {
      const result = run(executable, ['agent-host', '--probe'], options)
      assert.equal(result.status, 0, result.stderr)
      const probe = JSON.parse(result.stdout)
      validateReleaseMetadata(probe.release, report.runtime)
      assert.deepEqual(
        [...probe.agents].sort((left, right) => left.localeCompare(right)),
        ['codex', 'cursor', 'kiro', 'pi'],
      )
      assert.deepEqual(
        [...probe.nativeModules].sort((left, right) => left.localeCompare(right)),
        ['@napi-rs/keyring', 'cursor/tree-sitter', 'cursor/tree-sitter-bash'],
      )
      return probe
    })
    await check('cursorSqliteStore', async () => {
      const driver = join(root, 'cursor-package.mjs')
      await copyFile(fileURLToPath(new URL('./verify/cursor-package.mjs', import.meta.url)), driver)
      const result = run(process.execPath, [driver, installed, home], options)
      assert.equal(result.status, 0, result.stderr)
      const probe = JSON.parse(result.stdout)
      assert.equal(probe.sqliteStore, true)
      assert.equal(probe.modelCalls, 0)
      return { ...probe, runtime: 'Node driver with relocated installation dependencies' }
    })
    const cursorBin = join(installed, 'node_modules', '@cursor', `sdk-${process.platform}-${process.arch}`, 'bin')
    await check('cursorRipgrep', () => {
      const result = run(join(cursorBin, process.platform === 'win32' ? 'rg.exe' : 'rg'), ['--version'], options)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /ripgrep/)
      return { version: result.stdout.trim().split('\n')[0] }
    })
    await check('cursorSandbox', () => {
      const result = run(
        join(cursorBin, process.platform === 'win32' ? 'cursorsandbox.exe' : 'cursorsandbox'),
        ['--help'],
        options,
      )
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.trim() || result.stderr.trim(), 'Sandbox helper help must not be empty')
      return { loaded: true, exitCode: result.status }
    })
    await check('projectRuntime', () => runtimeHandshake(executable, options))
    await check('memoryRuntime', () => runtimeHandshake(executable, options, 'memory'))
    await check('memoryCancellation', async () => {
      const directory = join(home, 'memory-credentials')
      await mkdir(directory, { mode: 0o700 })
      const memoryOptions = { ...options, env: { ...options.env, BATON_PROJECT_RUNTIME_DATA_DIR: directory } }
      const result = run(executable, ['project-runtime', 'embedding-key', 'package-check'], {
        ...memoryOptions,
        input: 'package-check-embedding\n',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.ok(
        !result.stdout.includes('package-check-embedding') && !result.stderr.includes('package-check-embedding'),
      )
      const credentials = join(directory, 'embeddings')
      const file = join(credentials, 'package-check.json')
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { type: 'api_key', key: 'package-check-embedding' })
      if (process.platform !== 'win32')
        for (const path of [directory, credentials, file]) {
          assert.equal((await stat(path)).mode & 0o077, 0, '凭据目录和文件只能由当前用户访问')
        }
      return {
        ...(await runtimeHandshake(executable, memoryOptions, 'memory-cancel')),
        privateFiles: process.platform === 'win32' ? 'inherited permissions; ACL not checked' : 'owner-only',
      }
    })
    await check('credentials', async () => {
      const directory = join(home, 'credentials')
      const credential = JSON.stringify({
        type: 'oauth',
        access: 'package-check-local',
        refresh: 'package-check-refresh',
        expires: 0,
      })
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, 'openai-codex.json'), credential, { mode: 0o600 })
      const subscriptions = run(executable, ['subscriptions'], {
        ...options,
        env: { ...options.env, BATON_PROJECT_RUNTIME_DATA_DIR: directory },
      })
      assert.equal(subscriptions.status, 0, subscriptions.stderr)
      assert.match(subscriptions.stdout, /openai-codex.*已登录/)
      assert.ok(!subscriptions.stdout.includes('package-check-local'))
      assert.ok(!subscriptions.stdout.includes('package-check-refresh'))
      return { subscriptions: true, credentialValuesReported: false }
    })
    await check('missingDependencies', async () => {
      const dependencies = join(installed, 'node_modules')
      const hidden = join(root, 'hidden-node_modules')
      await rename(dependencies, hidden)
      try {
        const result = run(executable, ['agent-host', '--probe'], options)
        assert.ok(Number.isInteger(result.status) && result.status !== 0, 'Missing node_modules must fail')
        assert.equal(result.stdout, '', 'Missing dependencies must not emit successful probe output')
        assert.match(result.stderr, /node_modules/)
        assert.match(result.stderr, /installation_incomplete|安装包|完整安装|missing|incomplete/i)
        return { exitCode: result.status, diagnostic: result.stderr.trim() }
      } finally {
        await rename(hidden, dependencies)
      }
    })
  })
  report.isolation = { emptyPath: true, temporaryHome: true, relocatedPackage: true, sourceFiles: false }
  report.passed = Object.values(report.checks).every((check) => check.passed)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}

void main().catch((error) => {
  console.log(JSON.stringify({ ...environment(), passed: false, failure: { message: error.message } }, null, 2))
  process.exitCode = 1
})
