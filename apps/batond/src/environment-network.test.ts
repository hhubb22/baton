import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { expect, it } from 'vite-plus/test'
import { importEnvironment, resolveEnvironment } from './environment.ts'

const execute = promisify(execFile)

it('applies imported proxy and CA before child startup for HTTP, HTTPS and coordinator WSS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-environment-network-'))
  const certificate = fileURLToPath(new URL('./testing/data/environment-cert.pem', import.meta.url))
  const key = await readFile(new URL('./testing/data/environment-key.pem', import.meta.url))
  const plain = createServer((_request, response) => response.end('plain'))
  const secure = createSecureServer({ key, cert: await readFile(certificate) }, (_request, response) =>
    response.end('secure'),
  )
  const sockets = new Set<Socket>()
  const forwarded: number[] = []
  const allowedPorts = new Set<number>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }
  const proxy = createServer((incoming, response) => {
    const target = new URL(incoming.url!)
    if (target.hostname !== '127.0.0.1' || !allowedPorts.has(Number(target.port))) {
      response.writeHead(403).end()
      return
    }
    forwarded.push(Number(target.port))
    const outgoing = request(target, { method: incoming.method, headers: incoming.headers, agent: false }, (reply) => {
      response.writeHead(reply.statusCode!, reply.headers)
      reply.pipe(response)
    })
    outgoing.on('error', () => response.destroy())
    incoming.pipe(outgoing)
  })
  proxy.on('connect', (incoming, client, head) => {
    const target = new URL(`http://${incoming.url}`)
    if (target.hostname !== '127.0.0.1' || !allowedPorts.has(Number(target.port))) {
      client.destroy()
      return
    }
    forwarded.push(Number(target.port))
    const upstream = createConnection({ host: '127.0.0.1', port: Number(target.port) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    track(upstream)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  const servers: Server[] = [plain, secure, proxy]
  const websocket = new WebSocketServer({ server: secure })
  const listen = async (server: Server) => {
    server.on('connection', track)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    return address.port
  }
  try {
    const plainPort = await listen(plain)
    const securePort = await listen(secure)
    allowedPorts.add(plainPort)
    allowedPorts.add(securePort)
    const proxyPort = await listen(proxy)
    const config = await importEnvironment(directory, {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '',
      NODE_EXTRA_CA_CERTS: certificate,
    })
    const { env } = resolveEnvironment(config, { HOME: directory, PATH: '', SystemRoot: process.env.SystemRoot })
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    const args = [
      '--import',
      new URL('../../../runtimes/project-agent/node_modules/tsx/dist/loader.mjs', import.meta.url).href,
      fileURLToPath(new URL('./testing/environment-network.mjs', import.meta.url)),
      `http://127.0.0.1:${plainPort}`,
      `https://127.0.0.1:${securePort}`,
      `wss://127.0.0.1:${securePort}`,
    ]
    await expect(
      execute(process.execPath, args, { env: { ...env, NODE_EXTRA_CA_CERTS: undefined }, timeout: 15000 }),
    ).rejects.toThrow()
    forwarded.length = 0
    const result = await execute(process.execPath, args, { env, timeout: 15000 })
    expect(JSON.parse(result.stdout)).toEqual({
      http: 'plain',
      https: 'secure',
      updateRequest: 'secure',
      websocket: true,
    })
    expect(forwarded).toContain(plainPort)
    expect(forwarded.filter((port) => port === securePort)).toHaveLength(3)
    forwarded.length = 0
    const direct = await execute(process.execPath, args, {
      env: { ...env, NO_PROXY: '*', no_proxy: '*' },
      timeout: 15000,
    })
    expect(JSON.parse(direct.stdout)).toEqual({
      http: 'plain',
      https: 'secure',
      updateRequest: 'secure',
      websocket: true,
    })
    expect(forwarded).toEqual([])
    const disabled = await execute(process.execPath, args, {
      env: { ...env, NODE_USE_ENV_PROXY: '0' },
      timeout: 15000,
    })
    expect(JSON.parse(disabled.stdout)).toEqual({
      http: 'plain',
      https: 'secure',
      updateRequest: 'secure',
      websocket: true,
    })
    expect(forwarded).toEqual([])
  } finally {
    websocket.clients.forEach((socket) => socket.terminate())
    sockets.forEach((socket) => socket.destroy())
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
