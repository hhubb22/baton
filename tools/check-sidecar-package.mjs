import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { environment, isolatedEnv } from './ts-migration/common.mjs'
import { measureWorkerStartup, withTemporaryInstallation } from './ts-migration/worker-startup.mjs'

function run(executable, args, options) {
  const result = spawnSync(executable, args, {
    ...options,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, `${args.join(' ')} terminated by ${result.signal}`)
  return result
}

async function runtimeHandshake(executable, options) {
  const operations = ['bootstrap', 'read_events', 'claim_inputs']
  const observed = []
  return new Promise((resolveHandshake, reject) => {
    const child = spawn(executable, ['project-runtime', 'run'], {
      ...options,
      env: { ...options.env, BATON_SIDECAR_TRANSPORT: 'stdio' },
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
          if (frame.request.operation === 'bootstrap') {
            result = {
              type: 'project_runtime.result',
              ok: true,
              data: {
                project: {
                  title: 'Package check',
                  goal: '',
                  agent: { provider: 'openai-codex', model: 'package-check-unused' },
                  conversation: { id: 'package-check' },
                },
                prompt_version: 'package-check',
                after_seq: 0,
                last_seq: 0,
              },
            }
          } else if (frame.request.operation === 'read_events') {
            assert.equal(frame.request.after_seq, 0)
            result = { type: 'project_runtime.result', ok: true, data: { events: [], has_more: false } }
          } else {
            assert.equal(frame.request.last_seq, 0)
            // The coordinator ends this offline handshake before any input or model call.
            result = { type: 'project_runtime.result', ok: false, code: 'package_check_complete' }
          }
          child.stdin.write(JSON.stringify({ id: frame.id, result }) + '\n')
          if (observed.length === operations.length) child.stdin.end()
        }
      } catch (error) {
        fail(error)
      }
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        if (failure) throw failure
        assert.deepEqual(observed, operations, `Incomplete Project Runtime handshake: ${stderr}`)
        assert.equal(pending, '')
        assert.equal(signal, null)
        assert.equal(code, 1, `Runtime must exit after the coordinator's completion response: ${stderr}`)
        resolveHandshake({
          operations: observed,
          modelCalls: 0,
          exitCode: code,
          shutdown: 'coordinator completion response',
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const usage = 'Usage: node tools/check-sidecar-package.mjs [installation=bin] [--prepared driver-directory]'
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
    await check('help', () => {
      const result = run(executable, ['--help'], options)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Baton/i)
      assert.match(result.stdout, /register/)
      return { exitCode: result.status }
    })
    await check('version', () => {
      const result = run(executable, ['--version'], options)
      assert.equal(result.status, 0, result.stderr)
      const version = JSON.parse(result.stdout)
      assert.equal(version.sea, true)
      assert.equal(version.platform, process.platform)
      assert.equal(version.arch, process.arch)
      assert.match(version.node, /^v\d+\.\d+\.\d+/)
      report.runtime = version
      return version
    })
    await check('worker', async () => {
      const result = await measureWorkerStartup({ root, installed, samples: 1, preparedDirectory })
      assert.equal(result.passed, true, JSON.stringify(result.failure ?? result))
      return result
    })
    await check('agentHost', () => {
      const result = run(executable, ['agent-host', '--probe'], options)
      assert.equal(result.status, 0, result.stderr)
      const probe = JSON.parse(result.stdout)
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
    await check('projectRuntime', () => runtimeHandshake(executable, options))
    await check('privateFiles', () => {
      const directory = join(home, 'credentials')
      const file = join(directory, 'openai-codex.json')
      const credential = JSON.stringify({
        type: 'oauth',
        access: 'package-check-local',
        refresh: 'package-check-refresh',
        expires: 0,
      })
      for (const args of [
        ['protect-dir', directory],
        ['write', directory, file],
      ]) {
        const result = run(executable, ['sidecar-file', ...args], { ...options, input: credential })
        assert.equal(result.status, 0, result.stderr)
      }
      const read = run(executable, ['sidecar-file', 'read', directory, file], options)
      assert.equal(read.status, 0, read.stderr)
      assert.equal(read.stdout, credential)
      const subscriptions = run(executable, ['subscriptions'], {
        ...options,
        env: { ...options.env, BATON_PROJECT_RUNTIME_DATA_DIR: directory },
      })
      assert.equal(subscriptions.status, 0, subscriptions.stderr)
      assert.match(subscriptions.stdout, /openai-codex.*已登录/)
      assert.ok(!subscriptions.stdout.includes('package-check-local'))
      assert.ok(!subscriptions.stdout.includes('package-check-refresh'))
      const missing = run(executable, ['sidecar-file', 'read', directory, join(directory, 'missing.json')], options)
      assert.equal(missing.status, 3, missing.stderr)
      return { helper: 'SEA sidecar-file', subscriptions: true, credentialValuesReported: false }
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
