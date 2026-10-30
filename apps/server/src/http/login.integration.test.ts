import { request as httpRequest, type ClientRequest } from 'node:http'
import { once } from 'node:events'
import { Effect, Exit, Scope } from 'effect'
import { expect, it } from 'vite-plus/test'
import * as Auth from '../auth.ts'
import { CredentialSigner } from '../nodes.ts'
import { startServer, type ServerOptions } from '../server.ts'
import { withTestDatabase, type TestDatabase } from '../testing/database.ts'

const origin = 'https://baton.local'
const password = 'login-protection-password-123'

async function withLoginServer(
  test: (base: string, db: TestDatabase) => Promise<void>,
  options: Partial<ServerOptions> = {},
) {
  await withTestDatabase(async (db) => {
    const scope = await Effect.runPromise(Scope.make())
    try {
      const server = await db.run(
        startServer({
          port: 0,
          allowedOrigins: [origin],
          signer: CredentialSigner.generate(),
          dispatchMs: 60_000,
          projectDispatchMs: 60_000,
          ...options,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      await test(`http://${server.host}:${server.port}`, db)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
}

const login = (base: string, username: string, passwordValue = password, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', connection: 'close', ...headers },
    body: JSON.stringify({ username, password: passwordValue }),
    signal: AbortSignal.timeout(5000),
  })

it('limits an account across successful and failed real password checks and preserves generic authentication errors', () =>
  withLoginServer(
    async (base, db) => {
      await db.run(Auth.createEmployee('limitedalice', 'Alice', password))
      for (let attempt = 0; attempt < 10; attempt++) {
        const success = attempt < 2
        const response = await login(base, 'limitedalice', success ? password : 'incorrect-password', {
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
        })
        expect(response.status).toBe(success ? 200 : 401)
        if (success) expect(response.headers.get('set-cookie')).toContain('baton_session=')
        else expect(await response.json()).toMatchObject({ code: 'invalid_credentials' })
      }
      const blocked = await login(base, 'limitedalice', password, { 'x-forwarded-for': '203.0.113.1' })
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(300)
      expect(blocked.headers.get('cache-control')).toBe('no-store')
      expect(blocked.headers.get('set-cookie')).toBeNull()
      expect(await blocked.json()).toMatchObject({ request_id: expect.any(String) })
      const encoded = await fetch(`${base}/api/v1/%6cogin`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ username: 'limitedalice', password }),
        signal: AbortSignal.timeout(5000),
      })
      expect(encoded.status).toBe(429)
      await encoded.arrayBuffer()
      const missing = await login(base, 'missingaccount')
      expect(missing.status).toBe(401)
      expect(await missing.json()).toMatchObject({ code: 'invalid_credentials' })
    },
    { trustedProxyCidrs: '127.0.0.1/32' },
  ))

it('does not trust spoofed forwarded addresses and keeps IP limits across different accounts', () =>
  withLoginServer(async (base) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await login(base, `missing${attempt}`, 'incorrect-password', {
        'x-forwarded-for': `198.51.100.${attempt + 1}`,
      })
      expect(response.status).toBe(401)
      await response.arrayBuffer()
    }
    const response = await login(base, 'anotheraccount', password, { 'x-forwarded-for': '203.0.113.1' })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    await response.arrayBuffer()
  }))

it('counts malformed requests globally before allocating account counters or checking passwords', () =>
  withLoginServer(
    async (base) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const response = await fetch(`${base}/api/v1/login?source=test`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            connection: 'close',
            'x-forwarded-for': `198.51.100.${attempt + 1}`,
          },
          body: '{',
          signal: AbortSignal.timeout(5000),
        })
        expect(response.status).toBe(400)
        await response.arrayBuffer()
      }
      const response = await login(base, 'freshaccount', password, { 'x-forwarded-for': '203.0.113.1' })
      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      await response.arrayBuffer()
    },
    { trustedProxyCidrs: '127.0.0.1/32' },
  ))

it('rejects oversized login bodies with and without Content-Length', () =>
  withLoginServer(async (base) => {
    const body = JSON.stringify({ username: 'alice', password: 'x'.repeat(8192) })
    const response = await fetch(`${base}/api/v1/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', connection: 'close' },
      body,
      signal: AbortSignal.timeout(5000),
    })
    expect(response.status).toBe(413)
    await response.arrayBuffer()
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/v1/login`,
        {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', connection: 'close' },
        },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode!))
        },
      )
      request.once('error', reject)
      request.setTimeout(5000, () => request.destroy(new Error('Login response timed out')))
      request.write(body.slice(0, 4096))
      request.end(body.slice(4096))
    })
    expect(status).toBe(413)
  }))

it('keeps ordinary HTTP requests responsive while login request bodies are unfinished', () =>
  withLoginServer(async (base) => {
    const requests: ClientRequest[] = []
    try {
      await Promise.all(
        Array.from({ length: 18 }, async () => {
          const request = httpRequest(`${base}/api/v1/login`, {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'content-length': '256',
              expect: '100-continue',
              connection: 'close',
            },
          })
          requests.push(request)
          request.on('error', () => {})
          request.on('response', (response) => response.resume())
          const continued = once(request, 'continue')
          request.flushHeaders()
          await continued
          request.write('{"username":')
        }),
      )
      const response = await fetch(`${base}/api/v1/release`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(1500),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toHaveProperty('protocol_version')
    } finally {
      for (const request of requests) request.destroy()
    }
  }))
