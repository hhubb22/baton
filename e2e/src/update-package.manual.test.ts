import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, readdir, open } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect, Exit, Scope } from 'effect'
import { expect, test } from 'vite-plus/test'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import { identityMatches } from '@baton/batond/platform/identity'
import { updatePayloadBytes, type UpdatePayload } from '@baton/protocol/update-manifest'
import type { NodeStatus, EnrollmentResponse } from '@baton/protocol'

const execute = promisify(execFile)

// 显式指定两个本机构建的 SEA 安装目录；不连接外部服务，也不调用模型。
test('signed SEA package updates through local HTTPS and PostgreSQL with the same device identity', async () => {
  const from = process.env.BATON_UPGRADE_FROM
  const to = process.env.BATON_UPGRADE_TO
  if (!from || !to) throw new Error('Set BATON_UPGRADE_FROM and BATON_UPGRADE_TO to two SEA package directories')
  const source = resolve(from),
    target = resolve(to)
  const binary = process.platform === 'win32' ? 'batond.exe' : 'batond'
  const oldRelease = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'))
  const newRelease = JSON.parse(await readFile(join(target, 'release.json'), 'utf8'))
  expect(oldRelease.version).not.toBe(newRelease.version)
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bsu-')))
  const data = join(directory, 'data'),
    assets = join(directory, 'assets'),
    home = join(directory, 'home')
  await Promise.all([mkdir(data, { mode: 0o700 }), mkdir(assets), mkdir(home)])
  const environment = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }
  const run = (file: string, args: string[]) =>
    execute(file, args, { env: environment, timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
  const pair = generateKeyPairSync('ed25519')
  const archiveName = `baton-${newRelease.version}-${newRelease.platform}-${newRelease.arch}.tar.gz`
  await execute('tar', ['-czf', join(assets, archiveName), '-C', resolve(target, '..'), basename(target)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const archive = await readFile(join(assets, archiveName))
  const payload: UpdatePayload = {
    version: newRelease.version,
    commit: newRelease.commit,
    protocol_version: newRelease.protocol_version,
    server_image: `ghcr.io/hhubb22/baton@sha256:${'0'.repeat(64)}`,
    artifacts: [
      {
        kind: 'daemon',
        platform: newRelease.platform,
        arch: newRelease.arch,
        file: archiveName,
        size: archive.length,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    ],
  }
  await writeFile(
    join(assets, 'update-manifest.json'),
    JSON.stringify({
      format: 1,
      key_id: 'local',
      payload,
      signature: sign(null, updatePayloadBytes(payload), pair.privateKey).toString('base64url'),
    }),
  )
  await writeFile(
    join(data, 'update-trust.json'),
    JSON.stringify({ local: pair.publicKey.export({ type: 'spki', format: 'pem' }) }),
    { mode: 0o600 },
  )
  const key = join(directory, 'tls.key'),
    cert = join(directory, 'tls.pem')
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ])
  const database = await openTestDatabase()
  const scope = await Effect.runPromise(Scope.make())
  const log = await open(join(directory, 'daemon.log'), 'a')
  let proxy: ReturnType<typeof createServer> | undefined
  try {
    const origin = 'https://baton.local'
    const server = await database.run(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        dispatchMs: 20,
        heartbeatMs: 1000,
        offlineMs: 5000,
        webDirectory: directory,
        downloads: { directory: assets },
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    proxy = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
      const upstream = request(
        { hostname: '127.0.0.1', port: server.port, method: req.method, path: req.url, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        },
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
    })
    proxy.on('upgrade', (req, socket, head) => {
      const upstream = connect(server.port, '127.0.0.1', () => {
        upstream.write(
          `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
            .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : (value ?? '')}`)
            .join('\r\n')}\r\n\r\n`,
        )
        upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
    })
    await new Promise<void>((done) => proxy!.listen(0, '127.0.0.1', done))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('TLS proxy has no port')
    let cookie = '',
      csrf = ''
    const browser = async <A>(path: string, method = 'GET', body?: unknown): Promise<A> => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const nextCookie = response.headers.get('set-cookie')
      if (nextCookie) cookie = nextCookie.split(';')[0]!
      const value = response.status === 204 ? null : await response.json()
      if (value && typeof value === 'object' && 'csrf_token' in value) csrf = String(value.csrf_token)
      expect(response.status, JSON.stringify(value)).toBeLessThan(300)
      return value as A
    }
    const password = 'offline-package-initial-password-123'
    await database.run(Auth.createEmployee('packagealice', 'Alice', password))
    await browser('/login', 'POST', { username: 'packagealice', password })
    await browser('/me/password', 'POST', { current_password: password, new_password: `${password}-changed` })
    await browser('/login', 'POST', { username: 'packagealice', password: `${password}-changed` })
    const enrollment = await browser<EnrollmentResponse>('/node-enrollments', 'POST', {})
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.enrollment_token, { mode: 0o600 })
    const registered = await run(join(source, binary), [
      'register',
      '--data-dir',
      data,
      '--coordinator',
      `https://127.0.0.1:${address.port}`,
      '--ca-file',
      cert,
      '--enrollment-file',
      enrollmentFile,
      '--workspace',
      directory,
    ])
    const nodeId = JSON.parse(registered.stdout).node_id as string
    await run(join(source, binary), ['update', 'bootstrap', '--data-dir', data])
    const launcher = join(data, 'installation', 'launcher', binary)
    const child = spawn(launcher, ['dispatch', '--data-dir', data, '--', 'run', '--data-dir', data], {
      env: environment,
      stdio: ['ignore', log.fd, log.fd],
    })
    child.unref()
    child.on('exit', (code, signal) => console.log(JSON.stringify({ launcher_exit: code, signal })))
    child.on('error', (error) => console.log(`Launcher error: ${error.message}`))
    const status = () => browser<NodeStatus>(`/nodes/${nodeId}`)
    await expect
      .poll(async () => (await status()).runtime_report?.batond_version, { timeout: 30000 })
      .toBe(oldRelease.version)
    const identity = JSON.parse(await readFile(join(data, 'identity.json'), 'utf8'))
    await run(launcher, ['dispatch', '--data-dir', data, '--', 'update', '--data-dir', data])
    await expect
      .poll(async () => JSON.parse(await readFile(join(data, 'update-progress.json'), 'utf8')).phase, {
        timeout: 120000,
        interval: 1000,
      })
      .toBe('completed')
    await expect
      .poll(async () => (await status()).runtime_report?.batond_version, { timeout: 20000 })
      .toBe(newRelease.version)
    expect(JSON.parse(await readFile(join(data, 'identity.json'), 'utf8')).node_id).toBe(identity.node_id)
    const update = JSON.parse(await readFile(join(data, 'update-progress.json'), 'utf8'))
    expect((await status()).update_request).toMatchObject({ operation_id: update.operation_id, phase: 'completed' })
    expect(JSON.parse(await readFile(join(data, 'installation', 'current.json'), 'utf8')).release.version).toBe(
      newRelease.version,
    )
    expect(JSON.parse((await run(join(source, binary), ['--version', '--data-dir', data])).stdout).version).toBe(
      newRelease.version,
    )
    expect(JSON.parse((await run(join(source, binary), ['--binary-version'])).stdout).version).toBe(oldRelease.version)
    const lockDirectory = join(data, 'daemon.lock')
    const lockFile = (await readdir(lockDirectory))[0]!
    const previousProcess = JSON.parse(await readFile(join(lockDirectory, lockFile), 'utf8'))
    if (await identityMatches(previousProcess)) process.kill(previousProcess.pid, 'SIGTERM')
    await expect.poll(() => identityMatches(previousProcess), { timeout: 10000 }).toBe(false)
    const restarted = spawn(join(source, binary), ['run', '--data-dir', data], {
      env: environment,
      stdio: ['ignore', log.fd, log.fd],
    })
    restarted.unref()
    await expect
      .poll(
        async () => {
          const state = JSON.parse(await readFile(join(data, 'daemon-status.json'), 'utf8'))
          return state.pid !== previousProcess.pid && state.batond_version === newRelease.version
        },
        { timeout: 20000 },
      )
      .toBe(true)
    console.log(
      JSON.stringify({ from: oldRelease.version, to: newRelease.version, node_id: nodeId, phase: update.phase }),
    )
  } finally {
    for (const file of (await readdir(data)).filter((name) => name.endsWith('.lock'))) {
      try {
        const entries = await readdir(join(data, file))
        if (entries.length !== 1) continue
        const lock = JSON.parse(await readFile(join(data, file, entries[0]!), 'utf8'))
        if (lock.pid && lock.creationTime && (await identityMatches(lock))) process.kill(lock.pid, 'SIGTERM')
      } catch {
        /* 已退出进程无需清理。 */
      }
    }
    try {
      const launch = JSON.parse(await readFile(join(data, 'launcher-child.json'), 'utf8'))
      const identity = { pid: launch.launcher_pid, creationTime: launch.launcher_creation_time }
      if (await identityMatches(identity)) process.kill(identity.pid, 'SIGTERM')
    } catch {
      /* 启动器可能已经结束。 */
    }
    proxy?.closeAllConnections()
    proxy?.close()
    await database.run(Scope.close(scope, Exit.void))
    await database.close()
    await log.close()
    if (process.env.BATON_UPGRADE_KEEP !== '1') await rm(directory, { recursive: true, force: true })
    else console.log(`Package drill files: ${directory}`)
  }
}, 240000)
