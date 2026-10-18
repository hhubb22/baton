import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { access, chmod as chmodAsync, mkdir as mkdirAsync, readFile as readFileAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const exec = promisify(execFile)

export const webDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const repoRoot = path.resolve(webDir, '..')
export const statePath = path.join(webDir, '.e2e', 'state.json')

export type E2EState = {
  baseURL: string
  schema: string
  databaseURL: string
  apiPort: number
  controlPort: number
  nodePort: number
  certFile: string
  keyFile: string
  signingFile: string
  workDir: string
  logDir: string
  coordBin: string
  relayBin: string
  batondBin: string
  controlToken: string
  coordPid: number
  relayPid: number
  extraPids: number[]
  relayEnv: Record<string, string>
  alice: { username: string; password: string }
  bob: { username: string; password: string }
}

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/one_time_password=\S+/g, 'one_time_password=[redacted]')
  out = out.replace(/postgres:\/\/[^@\s]+@/g, 'postgres://[redacted]@')
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out
}

export function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return { ...env, ...overrides }
}

export async function readState(): Promise<E2EState> {
  const raw = await readFileAsync(statePath, 'utf8')
  return JSON.parse(raw) as E2EState
}

export async function writeState(state: E2EState): Promise<void> {
  await mkdirAsync(path.dirname(statePath), { recursive: true })
  await writeFileAsync(statePath, JSON.stringify(state), { mode: 0o600 })
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('没有分配到端口'))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function waitForPort(port: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    if (await portOpen(port)) return
    await delay(100)
  }
  throw new Error(`端口 ${port} 没有开始监听`)
}

export async function waitForPortClosed(port: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 8_000) {
    if (!(await portOpen(port))) return
    await delay(100)
  }
  throw new Error(`端口 ${port} 仍在监听`)
}

export async function stopPid(pid: number): Promise<void> {
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const start = Date.now()
  while (Date.now() - start < 8_000) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(100)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已经退出。
  }
}

export function spawnDetached(bin: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): number {
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(bin, args, { env, detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    if (!child.pid) throw new Error(`没有启动 ${path.basename(bin)}`)
    return child.pid
  } finally {
    closeSync(fd)
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('schema 名称无效')
  return `"${name}"`
}

async function dropSchema(databaseURL: string, schema: string): Promise<void> {
  if (!databaseURL || !schema) return
  const client = new Client({ connectionString: databaseURL })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
  } finally {
    await client.end()
  }
}

export async function cleanup(): Promise<void> {
  let state: E2EState | null = null
  try {
    state = await readState()
  } catch {
    return
  }
  await stopPid(state.relayPid)
  await stopPid(state.coordPid)
  for (const pid of state.extraPids) await stopPid(pid)
  await dropSchema(state.databaseURL, state.schema)
}

async function runLogged(bin: string, args: string[], env: NodeJS.ProcessEnv, secrets: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await exec(bin, args, { env, cwd, encoding: 'utf8', timeout: 180_000 })
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (err) {
    const text = err instanceof Error ? err.message : '命令失败'
    throw new Error(redact(text, secrets))
  }
}

function parseIssuedPassword(stdout: string): string {
  const line = stdout.split('\n').find((item) => item.startsWith('one_time_password='))
  const value = line?.slice('one_time_password='.length).trim() ?? ''
  if (value.length < 12) throw new Error('没有拿到一次性口令')
  return value
}

async function tail(file: string, secrets: string[]): Promise<string> {
  try {
    const text = await readFileAsync(file, 'utf8')
    return redact(text.slice(-2000), secrets)
  } catch {
    return ''
  }
}

export async function registerNode(state: E2EState, token: string, displayName: string, caps: string[], dataDir: string, legacyRole?: string): Promise<void> {
  const args = [
    'register',
    '--coordinator', state.baseURL,
    '--display-name', displayName,
    '--system', 'linux',
    '--data-dir', dataDir,
  ]
  if (legacyRole !== undefined) args.push('--role', legacyRole)
  for (const cap of caps) args.push('--capability', cap)
  if (args.some((arg) => arg.includes(token))) throw new Error('注册命令包含凭据')
  const { stderr } = await runLogged(state.batondBin, args, childEnv({
    BATON_ENROLLMENT_TOKEN: token,
    BATON_TLS_CA_FILE: state.certFile,
  }), [token])
  if (stderr.includes(token)) throw new Error('batond 输出包含注册凭据')
}

export function startBatond(state: E2EState, dataDir: string): number {
  return spawnDetached(state.batondBin, [
    'run',
    '--relay', `wss://127.0.0.1:${state.nodePort}/v1/node`,
    '--data-dir', dataDir,
  ], childEnv({
    BATON_TLS_CA_FILE: state.certFile,
    BATON_HEARTBEAT_INTERVAL: '200ms',
  }), path.join(state.logDir, 'batond.log'))
}

export async function trackPid(pid: number): Promise<E2EState> {
  const state = await readState()
  state.extraPids.push(pid)
  await writeState(state)
  return state
}

export async function restartRelay(state: E2EState): Promise<E2EState> {
  await stopPid(state.relayPid)
  await waitForPortClosed(state.nodePort)
  const current = await readState()
  const relayPid = spawnDetached(current.relayBin, [], current.relayEnv, path.join(current.logDir, 'relay.log'))
  const next = { ...current, relayPid }
  await writeState(next)
  await waitForPort(current.nodePort)
  return next
}

export async function setup(): Promise<void> {
  const databaseURL = process.env.BATON_TEST_DATABASE_URL?.trim() ?? ''
  if (!databaseURL) throw new Error('BATON_TEST_DATABASE_URL 未设置，端到端测试不能改用模拟数据库')
  const schema = `e2e${randomBytes(8).toString('hex')}`
  const workDir = path.join(webDir, '.e2e', schema)
  const logDir = path.join(workDir, 'logs')
  const binDir = path.join(workDir, 'bin')
  await mkdirAsync(logDir, { recursive: true })
  await mkdirAsync(binDir, { recursive: true })
  const secrets = [databaseURL]

  for (const name of ['coordinator', 'relay', 'batond']) {
    await runLogged('go', ['build', '-o', path.join(binDir, name), `./cmd/${name}`], process.env, secrets, repoRoot)
  }

  const certFile = path.join(workDir, 'cert.pem')
  const keyFile = path.join(workDir, 'key.pem')
  const signingFile = path.join(workDir, 'signing.pem')
  await runLogged('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyFile, '-out', certFile, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], process.env, secrets)
  await runLogged('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', signingFile], process.env, secrets)
  await chmodAsync(keyFile, 0o600)
  await chmodAsync(signingFile, 0o600)

  const apiPort = await freePort()
  const controlPort = await freePort()
  const nodePort = await freePort()
  const controlToken = randomBytes(24).toString('hex')
  const baseURL = `https://127.0.0.1:${apiPort}`
  const coordEnv = childEnv({
    BATON_DATABASE_URL: databaseURL,
    BATON_DB_SCHEMA: schema,
    BATON_HTTP_ADDR: `127.0.0.1:${apiPort}`,
    BATON_CONTROL_ADDR: `127.0.0.1:${controlPort}`,
    BATON_CONTROL_TOKEN: controlToken,
    BATON_NODE_SIGNING_KEY: signingFile,
    BATON_ALLOWED_ORIGINS: baseURL,
    BATON_TLS_CERT_FILE: certFile,
    BATON_TLS_KEY_FILE: keyFile,
    BATON_HEARTBEAT_INTERVAL: '200ms',
    BATON_OFFLINE_AFTER: '8s',
  })
  const relayEnv = childEnv({
    BATON_LISTEN_ADDR: `127.0.0.1:${nodePort}`,
    BATON_COORDINATOR_URL: `https://127.0.0.1:${controlPort}`,
    BATON_CONTROL_TOKEN: controlToken,
    BATON_TLS_CERT_FILE: certFile,
    BATON_TLS_KEY_FILE: keyFile,
    BATON_TLS_CA_FILE: certFile,
  })
  const state: E2EState = {
    baseURL,
    schema,
    databaseURL,
    apiPort,
    controlPort,
    nodePort,
    certFile,
    keyFile,
    signingFile,
    workDir,
    logDir,
    coordBin: path.join(binDir, 'coordinator'),
    relayBin: path.join(binDir, 'relay'),
    batondBin: path.join(binDir, 'batond'),
    controlToken,
    coordPid: 0,
    relayPid: 0,
    extraPids: [],
    relayEnv: relayEnv as Record<string, string>,
    alice: { username: 'alice', password: '' },
    bob: { username: 'bob', password: '' },
  }
  await writeState(state)
  try {
    await access(path.join(repoRoot, 'internal', 'webui', 'dist', 'index.html'))
    await runLogged(state.coordBin, ['migrate'], coordEnv, secrets)
    state.relayPid = spawnDetached(state.relayBin, [], relayEnv, path.join(logDir, 'relay.log'))
    await writeState(state)
    await delay(400)
    if (await portOpen(nodePort)) throw new Error('Relay 在拿到安全快照之前接受了节点连接')
    state.coordPid = spawnDetached(state.coordBin, ['serve'], coordEnv, path.join(logDir, 'coordinator.log'))
    await writeState(state)
    try {
      await waitForPort(apiPort)
      await waitForPort(nodePort)
    } catch (err) {
      const detail = await tail(path.join(logDir, 'coordinator.log'), secrets)
      const relayDetail = await tail(path.join(logDir, 'relay.log'), secrets)
      const reason = err instanceof Error ? err.message : '服务没有启动'
      throw new Error(`${reason}\n${detail}\n${relayDetail}`)
    }
    state.alice.password = await issuedPassword(state.coordBin, coordEnv, 'alice', 'Alice', secrets)
    state.bob.password = await issuedPassword(state.coordBin, coordEnv, 'bob', 'Bob', secrets)
    await writeState(state)
  } catch (err) {
    await cleanup()
    throw err
  }
}

async function issuedPassword(bin: string, env: NodeJS.ProcessEnv, username: string, displayName: string, secrets: string[]): Promise<string> {
  const { stdout, stderr } = await runLogged(bin, [
    'admin', 'employee', 'create', '--username', username, '--display-name', displayName,
  ], env, secrets)
  const password = parseIssuedPassword(stdout)
  if (stderr.includes(password)) throw new Error('创建账号的标准错误包含口令')
  return password
}

export async function assertLogsClean(state: E2EState, secrets: string[]): Promise<void> {
  for (const name of ['coordinator.log', 'relay.log', 'batond.log']) {
    let text = ''
    try {
      text = await readFileAsync(path.join(state.logDir, name), 'utf8')
    } catch {
      continue
    }
    for (const secret of secrets) {
      if (secret.length >= 8 && text.includes(secret)) {
        throw new Error(`${name} 包含凭据`)
      }
    }
    if (text.includes('postgres://')) throw new Error(`${name} 包含数据库连接串`)
  }
}
