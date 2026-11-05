import { randomBytes, randomUUID } from 'node:crypto'
import {
  DeviceLoginCreateInput,
  DeviceLoginTokenInput,
  UUID,
  type DeviceLoginCreateResponse,
  type DeviceLoginSession,
  type DeviceLoginTokenResponse,
} from '@baton/protocol'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { digest, newSecret } from './auth.ts'
import { dbError, transaction } from './database.ts'
import { AppError } from './errors.ts'
import type { CredentialSigner } from './nodes.ts'

const notFound = () => new AppError(404, 'device_login_not_found', '找不到待确认的设备登录')
const expired = () => new AppError(410, 'device_login_expired', '设备登录已过期，请重新发起')
const handled = () => new AppError(409, 'device_login_handled', '设备登录已处理，请重新发起')
const invalid = () => new AppError(400, 'invalid_request', '请求格式无效')
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const normalizeCode = (code: string): string => {
  const value = code.toUpperCase().replaceAll('-', '')
  return /^[A-HJ-NP-Z2-9]{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4)}` : ''
}

/** Only configured public HTTPS origins may appear in the browser verification link. */
export function deviceLoginOrigin(host: string, allowedOrigins: readonly string[]): string {
  for (const origin of allowedOrigins) {
    const url = new URL(origin)
    if (url.protocol === 'https:' && url.host.toLowerCase() === host.toLowerCase()) return url.origin
  }
  throw new AppError(400, 'coordinator_origin_unavailable', '无法确定中心的 HTTPS 地址')
}

export const createSession = Effect.fnUntraced(function* (
  input: DeviceLoginCreateInput,
  origin: string,
): Effect.fn.Return<DeviceLoginCreateResponse, AppError, SqlClient.SqlClient> {
  const request = yield* Schema.decodeUnknownEffect(DeviceLoginCreateInput)(input).pipe(Effect.mapError(invalid))
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (let attempt = 0; attempt < 5; attempt++) {
        const raw = Array.from(randomBytes(8), (byte) => alphabet[byte & 31]).join('')
        const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`
        const id = randomUUID()
        const deviceCode = newSecret()
        yield* sql`UPDATE device_login_sessions SET status='expired' WHERE user_code=${userCode} AND status='pending' AND expires_at<=clock_timestamp()`
        const [saved] = yield* sql<{ expires_at: Date }>`INSERT INTO device_login_sessions
          (id,device_code_hash,user_code,display_name,system,status,created_at,expires_at)
          VALUES(${id}::uuid,${digest(deviceCode)},${userCode},${request.display_name},${request.system},'pending',clock_timestamp(),clock_timestamp()+interval '600 seconds')
          ON CONFLICT DO NOTHING RETURNING expires_at`
        if (!saved) continue
        const uri = `${origin}/device-login`
        return {
          session_id: id,
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: uri,
          verification_uri_complete: `${uri}?code=${userCode}`,
          expires_at: saved.expires_at.toISOString(),
          expires_in_seconds: 600 as const,
          interval_seconds: 2 as const,
        }
      }
      return yield* Effect.fail(new AppError(503, 'unavailable'))
    }),
  )
})

export const sessionByCode = Effect.fnUntraced(function* (
  userCode: string,
): Effect.fn.Return<DeviceLoginSession, AppError, SqlClient.SqlClient> {
  const code = normalizeCode(userCode)
  if (!code) return yield* Effect.fail(notFound())
  const sql = yield* SqlClient.SqlClient
  const [session] = yield* sql<{
    id: string
    user_code: string
    display_name: string
    system: DeviceLoginCreateInput['system']
    expires_at: Date
    expired: boolean
    status: string
  }>`SELECT id::text,user_code,display_name,system,expires_at,expires_at<=clock_timestamp() OR status='expired' AS expired,status
    FROM device_login_sessions WHERE user_code=${code}
    ORDER BY (status='pending') DESC,created_at DESC LIMIT 1`.pipe(Effect.mapError(dbError))
  if (!session) return yield* Effect.fail(notFound())
  if (session.expired) return yield* Effect.fail(expired())
  if (session.status !== 'pending') return yield* Effect.fail(notFound())
  return {
    session_id: session.id,
    user_code: session.user_code,
    display_name: session.display_name,
    system: session.system,
    expires_at: session.expires_at.toISOString(),
  }
})

interface LoginSession {
  readonly id: string
  readonly user_code: string
  readonly display_name: string
  readonly system: DeviceLoginCreateInput['system']
  readonly status: 'pending' | 'approved' | 'consumed' | 'denied' | 'expired'
  readonly employee_id: string | null
  readonly node_id: string | null
  readonly credential_id: string | null
  readonly expired: boolean
}

const lockSession = Effect.fnUntraced(function* (id: string) {
  yield* Schema.decodeUnknownEffect(UUID)(id).pipe(Effect.mapError(notFound))
  const sql = yield* SqlClient.SqlClient
  const [session] = yield* sql<
    Omit<LoginSession, 'expired'>
  >`SELECT id::text,user_code,display_name,system,status,employee_id::text,node_id::text,credential_id::text
    FROM device_login_sessions WHERE id=${id}::uuid FOR UPDATE`
  if (!session) return yield* Effect.fail(notFound())
  // SELECT target expressions can run before a row-lock wait; read the clock after acquiring ownership.
  const [fresh] = yield* sql<{
    expired: boolean
  }>`SELECT expires_at<=clock_timestamp() AS expired FROM device_login_sessions WHERE id=${id}::uuid`
  return { ...session, expired: fresh.expired }
})

export const approveSession = Effect.fnUntraced(function* (employeeId: string, id: string, userCode: string) {
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const session = yield* lockSession(id)
      if (normalizeCode(userCode) !== session.user_code) return yield* Effect.fail(notFound())
      if (session.expired || session.status === 'expired') return yield* Effect.fail(expired())
      if (session.status !== 'pending') {
        if (session.employee_id === employeeId && ['approved', 'consumed'].includes(session.status))
          return session.node_id!
        return yield* Effect.fail(handled())
      }
      // Serializes first-device default assignment with every other registration path.
      yield* sql`INSERT INTO employee_settings(employee_id,updated_at) VALUES(${employeeId}::uuid,now()) ON CONFLICT DO NOTHING`
      yield* sql`SELECT employee_id FROM employee_settings WHERE employee_id=${employeeId}::uuid FOR UPDATE`
      const nodeId = randomUUID()
      const credentialId = randomUUID()
      yield* sql`INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version)
        VALUES(${nodeId}::uuid,${employeeId}::uuid,${session.display_name},${session.system},ARRAY[]::text[],nextval('node_registration_seq'),clock_timestamp(),1)`
      yield* sql`INSERT INTO node_credentials(id,node_id,employee_id,version,created_at,expires_at)
        VALUES(${credentialId}::uuid,${nodeId}::uuid,${employeeId}::uuid,1,clock_timestamp(),NULL)`
      const updated =
        yield* sql`UPDATE device_login_sessions SET status='approved',employee_id=${employeeId}::uuid,node_id=${nodeId}::uuid,credential_id=${credentialId}::uuid
        WHERE id=${id}::uuid AND status='pending' AND expires_at>clock_timestamp() RETURNING id`
      if (!updated.length) return yield* Effect.fail(expired())
      yield* sql`UPDATE employee_settings SET default_device_node_id=(SELECT id FROM nodes WHERE employee_id=${employeeId}::uuid AND revoked_at IS NULL ORDER BY registration_seq LIMIT 1),updated_at=now()
        WHERE employee_id=${employeeId}::uuid AND default_device_node_id IS NULL`
      return nodeId
    }),
  )
})

export const denySession = Effect.fnUntraced(function* (employeeId: string, id: string) {
  yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const session = yield* lockSession(id)
      if (session.expired || session.status === 'expired') return yield* Effect.fail(expired())
      if (session.status === 'denied' && session.employee_id === employeeId) return
      if (session.status !== 'pending') return yield* Effect.fail(handled())
      const updated = yield* sql`UPDATE device_login_sessions SET status='denied',employee_id=${employeeId}::uuid
        WHERE id=${id}::uuid AND status='pending' AND expires_at>clock_timestamp() RETURNING id`
      if (!updated.length) return yield* Effect.fail(expired())
    }),
  )
})

export const token = Effect.fnUntraced(function* (
  input: DeviceLoginTokenInput,
  signer: CredentialSigner,
): Effect.fn.Return<DeviceLoginTokenResponse, AppError, SqlClient.SqlClient> {
  const request = yield* Schema.decodeUnknownEffect(DeviceLoginTokenInput)(input).pipe(Effect.mapError(invalid))
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const session = yield* lockSession(request.session_id)
      const proof =
        yield* sql`SELECT id FROM device_login_sessions WHERE id=${request.session_id}::uuid AND device_code_hash=${digest(request.device_code)}`
      if (!proof.length) return yield* Effect.fail(new AppError(401, 'invalid_device_code', '设备登录凭据无效'))
      if (session.expired || session.status === 'expired') {
        yield* sql`UPDATE device_login_sessions SET status='expired' WHERE id=${session.id}::uuid AND status<>'expired'`
        return { status: 'expired' as const }
      }
      if (session.status === 'denied') return { status: 'denied' as const }
      if (session.status === 'pending') return { status: 'pending' as const, interval_seconds: 2 as const }
      // Match revocation's Node -> Credential lock order; a retry cannot revive a revoked identity.
      const [node] = yield* sql<{
        registration_seq: number
        registered_at: Date
        revoked_at: Date | null
        credential_version: number
      }>`SELECT registration_seq::float8,registered_at,revoked_at,credential_version FROM nodes WHERE id=${session.node_id}::uuid AND employee_id=${session.employee_id}::uuid FOR UPDATE`
      const [credential] = yield* sql<{
        id: string
        version: number
        created_at: Date
        revoked_at: Date | null
      }>`SELECT id::text,version,created_at,revoked_at FROM node_credentials WHERE id=${session.credential_id}::uuid AND node_id=${session.node_id}::uuid AND employee_id=${session.employee_id}::uuid FOR UPDATE`
      if (
        !node ||
        !credential ||
        node.revoked_at ||
        credential.revoked_at ||
        node.credential_version !== credential.version
      )
        return yield* Effect.fail(
          new AppError(401, 'credential_revoked', '设备连接凭据已吊销，请先解除本机绑定后重新登录'),
        )
      const consumed =
        yield* sql`UPDATE device_login_sessions SET status='consumed',consumed_at=COALESCE(consumed_at,clock_timestamp())
        WHERE id=${session.id}::uuid AND status IN ('approved','consumed') AND expires_at>clock_timestamp() RETURNING id`
      if (!consumed.length) {
        yield* sql`UPDATE device_login_sessions SET status='expired' WHERE id=${session.id}::uuid`
        return { status: 'expired' as const }
      }
      return {
        status: 'approved' as const,
        identity: {
          node_id: session.node_id!,
          employee_id: session.employee_id!,
          display_name: session.display_name,
          system: session.system,
          role: 'pc',
          capabilities: [],
          registration_seq: node.registration_seq,
          registered_at: node.registered_at.toISOString(),
          credential: {
            id: credential.id,
            version: credential.version,
            token: signer.sign({
              node_id: session.node_id!,
              employee_id: session.employee_id!,
              credential_id: credential.id,
              credential_version: credential.version,
              issued_at: Math.floor(credential.created_at.getTime() / 1000),
            }),
            expires_at: null,
          },
          signing_public_key: signer.signingPublicKey,
        },
      }
    }),
  )
})
