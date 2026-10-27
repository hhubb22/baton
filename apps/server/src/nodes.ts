import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RuntimeReport, ReauthNodeInput } from '@baton/protocol'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { digest, hasControlCharacters, newSecret } from './auth.ts'
import { type DatabaseEffect, dbError } from './database.ts'
import { AppError, type NodeSource } from './errors.ts'
import { digest as requestDigest } from './json.ts'

export interface NodeClaims {
  readonly node_id: string
  readonly employee_id: string
  readonly credential_id: string
  readonly issued_at?: number
  readonly credential_version?: number
}

export const NODE_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60
const idleExpired = () =>
  new AppError(401, 'node_idle_expired', '设备已闲置 30 天，请为原设备领取凭据并执行 batond reauth')

export interface RegisterInput {
  readonly enrollment_token: string
  readonly display_name: string
  readonly system: string
  readonly capabilities: readonly string[] | null
}
export type SyncInput = Omit<RegisterInput, 'enrollment_token'>

export interface NodeIdentity extends SyncInput {
  readonly node_id: string
  readonly employee_id: string
  readonly role: 'pc'
  readonly registration_seq: number
  readonly registered_at: string
  readonly credential: {
    readonly id: string
    readonly version: number
    readonly token: string
    readonly expires_at: string
  }
  readonly signing_public_key: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const forbidden = () => new AppError(403, 'forbidden', '不能操作该设备')
const rejectedSource = () => new AppError(401, 'node_source_rejected', '设备连接身份已失效')
const timestamp = (date: Date | null): string | null => date?.toISOString() ?? null

/** Coordinator 的 Ed25519 密钥签发和验证节点凭据。 */
export class CredentialSigner {
  readonly publicKey: KeyObject
  readonly signingPublicKey: string

  constructor(private readonly privateKey: KeyObject) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new AppError(500, 'invalid_signing_key', '节点签名密钥无效')
    }
    this.publicKey = createPublicKey(privateKey)
    this.signingPublicKey = this.publicKey.export({ format: 'jwk' }).x!
  }

  static generate(): CredentialSigner {
    return new CredentialSigner(generateKeyPairSync('ed25519').privateKey)
  }

  sign(claims: NodeClaims): string {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'baton-coordinator',
        aud: ['baton-node'],
        sub: claims.node_id,
        jti: claims.credential_id,
        iat: claims.issued_at ?? Math.floor(Date.now() / 1000),
        credential_version: claims.credential_version ?? 1,
        node_id: claims.node_id,
        employee_id: claims.employee_id,
        credential_id: claims.credential_id,
      }),
    ).toString('base64url')
    const body = `${header}.${payload}`
    return `${body}.${sign(null, Buffer.from(body), this.privateKey).toString('base64url')}`
  }

  verify(token: string): NodeClaims {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error()
      const [headerPart, payloadPart, signaturePart] = token.split('.')
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
      const now = Date.now() / 1000
      if (
        header.alg !== 'EdDSA' ||
        header.crit !== undefined ||
        header.b64 !== undefined ||
        !verify(
          null,
          Buffer.from(`${headerPart}.${payloadPart}`),
          this.publicKey,
          Buffer.from(signaturePart, 'base64url'),
        ) ||
        payload.iss !== 'baton-coordinator' ||
        !(payload.aud === 'baton-node' || (Array.isArray(payload.aud) && payload.aud.includes('baton-node'))) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.credential_version) ||
        payload.credential_version < 1 ||
        (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now)) ||
        !uuidPattern.test(payload.node_id ?? '') ||
        !uuidPattern.test(payload.employee_id ?? '') ||
        !uuidPattern.test(payload.credential_id ?? '') ||
        payload.sub !== payload.node_id ||
        payload.jti !== payload.credential_id
      )
        throw new Error()
      return {
        node_id: payload.node_id,
        employee_id: payload.employee_id,
        credential_id: payload.credential_id,
        issued_at: payload.iat,
        credential_version: payload.credential_version,
      }
    } catch {
      throw new AppError(401, 'invalid_node_credential', '设备连接凭据无效')
    }
  }
}

/**
 * Windows 只用只读位表达权限，Node 返回的 mode 恒为 0666 或 0444，chmod 也不改变组/其他位，
 * 因此无法用 POSIX 语义校验；此时依赖安装目录的继承 ACL，其余平台要求组与其他位全空。
 */
function permissionBitsUnsafe(mode: number): boolean {
  return process.platform !== 'win32' && (mode & 0o077) !== 0
}

/** 允许初始化时仅在路径不存在时创建密钥；恢复要求原密钥通过完整校验。 */
export async function loadSigningKey(path: string, createIfMissing = true): Promise<CredentialSigner> {
  const invalid = () =>
    new AppError(
      500,
      'invalid_signing_key',
      createIfMissing
        ? '无法安全读取节点签名密钥'
        : '恢复需要原节点签名密钥，文件缺失或无法安全读取；请恢复配套密钥并核对权限',
    )
  try {
    try {
      await lstat(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      if (!createIfMissing) throw invalid()
      const directory = dirname(path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.node-signing-${randomUUID()}`)
      const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        await handle.writeFile(generated)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(temporary, path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      } finally {
        await unlink(temporary)
      }
      // Windows 拒绝对目录句柄执行 fsync（EPERM），目录项由 NTFS 日志保证持久化。
      if (process.platform !== 'win32') {
        const directoryHandle = await open(directory, constants.O_RDONLY)
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    }
    const before = await lstat(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      permissionBitsUnsafe(before.mode) ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw invalid()
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const actual = await handle.stat()
      if (
        !actual.isFile() ||
        actual.dev !== before.dev ||
        actual.ino !== before.ino ||
        permissionBitsUnsafe(actual.mode) ||
        (process.getuid && actual.uid !== process.getuid()) ||
        actual.size > 4096
      )
        throw invalid()
      const raw = await handle.readFile('utf8')
      if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(raw)) throw invalid()
      return new CredentialSigner(createPrivateKey(raw))
    } finally {
      await handle.close()
    }
  } catch {
    throw invalid()
  }
}

function validateNode(input: SyncInput): void {
  if (
    typeof input.display_name !== 'string' ||
    input.display_name.trim() !== input.display_name ||
    Array.from(input.display_name).length < 1 ||
    Array.from(input.display_name).length > 80 ||
    hasControlCharacters(input.display_name) ||
    !['windows', 'macos', 'linux'].includes(input.system) ||
    (input.capabilities !== null && !Array.isArray(input.capabilities)) ||
    (input.capabilities ?? []).length > 32 ||
    new Set(input.capabilities ?? []).size !== (input.capabilities ?? []).length ||
    (input.capabilities ?? []).some((cap) => typeof cap !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(cap))
  ) {
    throw new AppError(400, 'invalid_node', '设备名字、系统或能力列表无效')
  }
}

function validateSource(source: NodeSource): void {
  if (
    ![source.node_id, source.employee_id, source.credential_id].every((id) => uuidPattern.test(id)) ||
    !source.conn_id ||
    source.conn_id.length > 80 ||
    !source.incarnation ||
    source.incarnation.length > 80
  )
    throw rejectedSource()
}

export const issueEnrollment = (employeeId: string, ttlSeconds = 600): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
      return yield* Effect.fail(new AppError(400, 'invalid_ttl', '注册凭据有效期无效'))
    }
    const id = randomUUID(),
      token = newSecret()
    const rows = yield* sql<{ expires_at: Date; expires_in_ms: number }>`INSERT INTO node_enrollments
      (id, employee_id, token_hash, created_at, expires_at)
      VALUES (${id}::uuid, ${employeeId}::uuid, ${digest(token)}, now(), clock_timestamp()+${ttlSeconds}*interval '1 second')
      RETURNING expires_at, GREATEST(0, EXTRACT(epoch FROM expires_at-clock_timestamp())*1000)::float8 AS expires_in_ms`
    return {
      enrollment_id: id,
      enrollment_token: token,
      expires_at: rows[0].expires_at.toISOString(),
      expires_in_ms: Math.floor(rows[0].expires_in_ms),
    }
  }).pipe(Effect.mapError(dbError))

export const issueReauthEnrollment = (employeeId: string, nodeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const nodes =
          yield* sql`SELECT id FROM nodes WHERE id=${nodeId}::uuid AND employee_id=${employeeId}::uuid AND revoked_at IS NULL FOR UPDATE`
        if (!nodes.length) return yield* Effect.fail(forbidden())
        const enrollment = yield* issueEnrollment(employeeId)
        yield* sql`UPDATE node_enrollments SET target_node_id=${nodeId}::uuid WHERE id=${enrollment.enrollment_id as string}::uuid`
        return enrollment
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const reauthenticateNode = (
  nodeId: string,
  input: typeof ReauthNodeInput.Type,
  signer: CredentialSigner,
): DatabaseEffect<NodeIdentity> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ReauthNodeInput)(input),
      catch: () => new AppError(400, 'invalid_request'),
    })
    const previous = yield* Effect.try({ try: () => signer.verify(request.previous_token), catch: dbError })
    if (previous.node_id !== nodeId) return yield* Effect.fail(forbidden())
    const hash = requestDigest({ node_id: nodeId, ...request })
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [node] = yield* sql<{
          employee_id: string
          display_name: string
          system_name: string
          capabilities: string[]
          registration_seq: number
          registered_at: Date
          credential_version: number
        }>`SELECT employee_id::text,display_name,system_name,capabilities,registration_seq::float8,registered_at,credential_version FROM nodes WHERE id=${nodeId}::uuid AND employee_id=${previous.employee_id}::uuid AND revoked_at IS NULL FOR UPDATE`
        if (!node) return yield* Effect.fail(forbidden())
        const [current] = yield* sql<{
          id: string
        }>`SELECT id::text FROM node_credentials WHERE node_id=${nodeId}::uuid AND version=${node.credential_version} AND revoked_at IS NULL FOR UPDATE`
        if (!current) return yield* Effect.fail(rejectedSource())
        const [presence] = yield* sql<{
          online: boolean
        }>`SELECT online FROM node_presence WHERE node_id=${nodeId}::uuid FOR UPDATE`
        if (presence?.online)
          return yield* Effect.fail(new AppError(409, 'incarnation_conflict', '请先停止原设备的 batond，再重新认证'))
        const [enrollment] = yield* sql<{
          id: string
          employee_id: string
          target_node_id: string | null
          used_at: Date | null
          expired: boolean
          operation_id: string | null
          request_hash: Uint8Array | null
          issued_credential_id: string | null
        }>`SELECT id::text,employee_id::text,target_node_id::text,used_at,expires_at<=clock_timestamp() AS expired,operation_id::text,request_hash,issued_credential_id::text FROM node_enrollments WHERE token_hash=${digest(request.enrollment_token)} FOR UPDATE`
        if (!enrollment || enrollment.employee_id !== previous.employee_id || enrollment.target_node_id !== nodeId)
          return yield* Effect.fail(new AppError(401, 'invalid_enrollment', '重新认证凭据与原设备不匹配'))
        if (enrollment.used_at) {
          if (
            enrollment.operation_id !== request.operation_id ||
            !enrollment.request_hash ||
            !Buffer.from(enrollment.request_hash).equals(hash)
          )
            return yield* Effect.fail(new AppError(409, 'reauth_conflict', '重新认证操作与原请求不一致'))
          if (enrollment.issued_credential_id !== current.id) return yield* Effect.fail(rejectedSource())
        } else {
          if (current.id !== previous.credential_id) return yield* Effect.fail(rejectedSource())
          const duplicate = yield* sql`SELECT id FROM node_enrollments WHERE operation_id=${request.operation_id}::uuid`
          if (duplicate.length) return yield* Effect.fail(new AppError(409, 'reauth_conflict'))
          const consumed =
            yield* sql`UPDATE node_enrollments SET used_at=clock_timestamp(),device_id=${nodeId}::uuid,operation_id=${request.operation_id}::uuid,request_hash=${hash},previous_credential_id=${previous.credential_id}::uuid,issued_credential_id=${randomUUID()}::uuid WHERE id=${enrollment.id}::uuid AND expires_at>clock_timestamp() RETURNING issued_credential_id`
          if (enrollment.expired || !consumed.length)
            return yield* Effect.fail(new AppError(401, 'enrollment_expired', '重新认证凭据已过期'))
          yield* sql`UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=${current.id}::uuid`
          yield* sql`UPDATE nodes SET credential_version=credential_version+1 WHERE id=${nodeId}::uuid`
          yield* sql`INSERT INTO node_credentials(id,node_id,employee_id,version,created_at,last_business_at,expires_at)
          SELECT e.issued_credential_id,n.id,n.employee_id,n.credential_version,e.used_at,e.used_at,e.used_at+${NODE_IDLE_TTL_SECONDS}*interval '1 second' FROM nodes n JOIN node_enrollments e ON e.id=${enrollment.id}::uuid WHERE n.id=${nodeId}::uuid`
          yield* sql`UPDATE node_presence SET online=false,synced=false WHERE node_id=${nodeId}::uuid`
        }
        const [credential] = yield* sql<{
          id: string
          version: number
          created_at: Date
        }>`SELECT c.id::text,c.version,c.created_at FROM node_credentials c JOIN node_enrollments e ON e.issued_credential_id=c.id WHERE e.id=${enrollment.id}::uuid`
        const issuedAt = Math.floor(credential.created_at.getTime() / 1000)
        const token = signer.sign({
          node_id: nodeId,
          employee_id: node.employee_id,
          credential_id: credential.id,
          credential_version: credential.version,
          issued_at: issuedAt,
        })
        return {
          node_id: nodeId,
          employee_id: node.employee_id,
          display_name: node.display_name,
          system: node.system_name,
          capabilities: node.capabilities,
          role: 'pc' as const,
          registration_seq: node.registration_seq,
          registered_at: node.registered_at.toISOString(),
          credential: {
            id: credential.id,
            version: credential.version,
            token,
            expires_at: new Date(credential.created_at.getTime() + NODE_IDLE_TTL_SECONDS * 1000).toISOString(),
          },
          signing_public_key: signer.signingPublicKey,
        }
      }),
    )
  }).pipe(
    Effect.catchTag('SqlError', (error) =>
      Effect.fail(
        error.reason._tag === 'UniqueViolation' && error.reason.constraint === 'node_enrollments_operation_id_key'
          ? new AppError(409, 'reauth_conflict', '重新认证操作与原请求不一致')
          : dbError(error),
      ),
    ),
    Effect.mapError(dbError),
  )

export const getEnrollment = (employeeId: string, enrollmentId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!uuidPattern.test(enrollmentId)) return yield* Effect.fail(new AppError(404, 'not_found', '找不到注册凭据'))
    const rows = yield* sql<{
      id: string
      device_id: string | null
      expires_at: Date
      used: boolean
      expired: boolean
      connected: boolean
      expires_in_ms: number
    }>`
      SELECT e.id::text, e.device_id::text, e.expires_at, e.used_at IS NOT NULL AS used,
        e.expires_at<=clock_timestamp() AS expired, COALESCE(p.online AND p.synced AND n.revoked_at IS NULL,false) AS connected,
        GREATEST(0, EXTRACT(epoch FROM e.expires_at-clock_timestamp())*1000)::float8 AS expires_in_ms
      FROM node_enrollments e LEFT JOIN nodes n ON n.id=e.device_id AND n.employee_id=e.employee_id
      LEFT JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id
      WHERE e.id=${enrollmentId}::uuid AND e.employee_id=${employeeId}::uuid`
    if (!rows[0]) return yield* Effect.fail(new AppError(404, 'not_found', '找不到注册凭据'))
    const row = rows[0]
    return {
      enrollment_id: row.id,
      device_id: row.device_id,
      state: row.used ? (row.connected ? 'connected' : 'used') : row.expired ? 'expired' : 'pending',
      expires_at: row.expires_at.toISOString(),
      expires_in_ms: Math.floor(row.expires_in_ms),
    }
  }).pipe(Effect.mapError(dbError))

export const registerNode = (input: RegisterInput, signer: CredentialSigner): DatabaseEffect<NodeIdentity> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.try({ try: () => validateNode(input), catch: dbError })
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(input.enrollment_token)) {
      return yield* Effect.fail(new AppError(401, 'invalid_enrollment', '注册凭据无效'))
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const consumed = yield* sql<{ employee_id: string }>`UPDATE node_enrollments SET used_at=clock_timestamp()
        WHERE token_hash=${digest(input.enrollment_token)} AND target_node_id IS NULL AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING employee_id::text`
        if (!consumed[0]) {
          const reason = yield* sql<{ used: boolean; expired: boolean }>`SELECT used_at IS NOT NULL AS used,
          expires_at<=clock_timestamp() AS expired FROM node_enrollments WHERE token_hash=${digest(input.enrollment_token)}`
          const code = reason[0]?.used
            ? 'enrollment_used'
            : reason[0]?.expired
              ? 'enrollment_expired'
              : 'invalid_enrollment'
          return yield* Effect.fail(new AppError(401, code, '注册凭据无效、已使用或已过期'))
        }
        const employeeId = consumed[0].employee_id,
          nodeId = randomUUID(),
          credentialId = randomUUID()
        yield* sql`INSERT INTO employee_settings (employee_id, updated_at) VALUES (${employeeId}::uuid, now()) ON CONFLICT DO NOTHING`
        yield* sql`SELECT employee_id FROM employee_settings WHERE employee_id=${employeeId}::uuid FOR UPDATE`
        const nodes = yield* sql<{ registration_seq: number; registered_at: Date }>`INSERT INTO nodes
        (id, employee_id, display_name, system_name, capabilities, registration_seq, registered_at, credential_version)
        VALUES (${nodeId}::uuid, ${employeeId}::uuid, ${input.display_name}, ${input.system},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.capabilities ?? [])}::jsonb)), nextval('node_registration_seq'), now(), 1)
        RETURNING registration_seq::float8, registered_at`
        const credentials = yield* sql<{
          expires_at: Date
        }>`INSERT INTO node_credentials (id, node_id, employee_id, version, created_at, expires_at)
        VALUES (${credentialId}::uuid, ${nodeId}::uuid, ${employeeId}::uuid, 1, now(),
          clock_timestamp()+${NODE_IDLE_TTL_SECONDS}*interval '1 second') RETURNING expires_at`
        const expiresAt = credentials[0].expires_at.toISOString()
        const token = yield* Effect.try({
          try: () =>
            signer.sign({
              node_id: nodeId,
              employee_id: employeeId,
              credential_id: credentialId,
              credential_version: 1,
            }),
          catch: dbError,
        })
        yield* sql`UPDATE node_enrollments SET device_id=${nodeId}::uuid WHERE token_hash=${digest(input.enrollment_token)}`
        yield* sql`UPDATE employee_settings SET default_device_node_id=(SELECT id FROM nodes WHERE employee_id=${employeeId}::uuid
        AND revoked_at IS NULL ORDER BY registration_seq LIMIT 1), updated_at=now() WHERE employee_id=${employeeId}::uuid AND default_device_node_id IS NULL`
        return {
          node_id: nodeId,
          employee_id: employeeId,
          display_name: input.display_name,
          system: input.system,
          capabilities: [...(input.capabilities ?? [])],
          role: 'pc' as const,
          registration_seq: nodes[0].registration_seq,
          registered_at: nodes[0].registered_at.toISOString(),
          credential: { id: credentialId, version: 1, token, expires_at: expiresAt },
          signing_public_key: signer.signingPublicKey,
        }
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const authenticateNode = (token: string, signer: CredentialSigner): DatabaseEffect<NodeClaims> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const claims = yield* Effect.try({ try: () => signer.verify(token), catch: dbError })
    const rows = yield* sql<{
      expired: boolean
    }>`SELECT c.expires_at<=clock_timestamp() AS expired FROM nodes n JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id
    WHERE n.id=${claims.node_id}::uuid AND n.employee_id=${claims.employee_id}::uuid AND c.id=${claims.credential_id}::uuid
      AND c.version=n.credential_version AND n.revoked_at IS NULL AND c.revoked_at IS NULL`
    if (!rows[0]) return yield* Effect.fail(new AppError(401, 'invalid_node_credential', '设备连接凭据无效'))
    if (rows[0].expired) return yield* Effect.fail(idleExpired())
    return claims
  }).pipe(Effect.mapError(dbError))

/** 必须在调用方事务内执行，锁顺序为 Node、Credential、Presence。 */
export const lockNodeSource = (source: NodeSource, requireSynced = true): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.try({ try: () => validateSource(source), catch: dbError })
    const node =
      yield* sql`SELECT id FROM nodes WHERE id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid AND revoked_at IS NULL FOR UPDATE`
    if (!node[0]) return yield* Effect.fail(rejectedSource())
    const credential =
      yield* sql`SELECT c.id FROM node_credentials c JOIN nodes n ON n.id=c.node_id AND n.employee_id=c.employee_id
    WHERE c.id=${source.credential_id}::uuid AND c.node_id=${source.node_id}::uuid AND c.employee_id=${source.employee_id}::uuid
      AND c.version=n.credential_version AND c.revoked_at IS NULL FOR UPDATE OF c`
    if (!credential[0]) return yield* Effect.fail(rejectedSource())
    const presence =
      yield* sql`SELECT node_id FROM node_presence WHERE node_id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid
    AND conn_id=${source.conn_id} AND incarnation=${source.incarnation} AND online AND (NOT ${requireSynced} OR synced) FOR SHARE`
    if (!presence[0]) return yield* Effect.fail(rejectedSource())
    yield* revalidateNodeSource(source, requireSynced)
  }).pipe(Effect.mapError(dbError))

/** 业务行锁取得后再次按数据库当前时刻核对来源。 */
export const revalidateNodeSource = (source: NodeSource, requireSynced = true): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      expired: boolean
    }>`SELECT c.expires_at<=clock_timestamp() AS expired FROM nodes n JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id
    JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id
    WHERE n.id=${source.node_id}::uuid AND n.employee_id=${source.employee_id}::uuid AND n.revoked_at IS NULL
      AND c.id=${source.credential_id}::uuid AND c.version=n.credential_version AND c.revoked_at IS NULL
      AND p.conn_id=${source.conn_id} AND p.incarnation=${source.incarnation} AND p.online AND (NOT ${requireSynced} OR p.synced)`
    if (!rows[0]) return yield* Effect.fail(rejectedSource())
    if (rows[0].expired) return yield* Effect.fail(idleExpired())
  }).pipe(Effect.mapError(dbError))

/** 首次有效业务与续期由调用方在同一事务保存，来源已持有 Node、Credential 写锁。 */
export const recordNodeBusiness = (source: NodeSource): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* revalidateNodeSource(source)
    const rows = yield* sql`UPDATE node_credentials SET
      last_business_at=GREATEST(last_business_at,clock_timestamp()),
      expires_at=GREATEST(expires_at,clock_timestamp()+${NODE_IDLE_TTL_SECONDS}*interval '1 second')
      WHERE id=${source.credential_id}::uuid AND expires_at>clock_timestamp() RETURNING id`
    if (!rows.length) return yield* Effect.fail(idleExpired())
  }).pipe(Effect.mapError(dbError))

export const claimConnection = (source: NodeSource): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.try({ try: () => validateSource(source), catch: dbError })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const nodes =
          yield* sql`SELECT id FROM nodes WHERE id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid AND revoked_at IS NULL FOR UPDATE`
        if (!nodes[0]) return yield* Effect.fail(rejectedSource())
        const creds = yield* sql`SELECT c.id FROM node_credentials c JOIN nodes n ON n.id=c.node_id
      WHERE c.id=${source.credential_id}::uuid AND c.node_id=${source.node_id}::uuid AND c.employee_id=${source.employee_id}::uuid
      AND c.version=n.credential_version AND c.revoked_at IS NULL FOR UPDATE OF c`
        if (!creds[0]) return yield* Effect.fail(rejectedSource())
        const old = yield* sql<{
          incarnation: string
          online: boolean
        }>`SELECT incarnation, online FROM node_presence WHERE node_id=${source.node_id}::uuid FOR UPDATE`
        if (old[0]?.online && old[0].incarnation !== source.incarnation) {
          return yield* Effect.fail(new AppError(409, 'incarnation_conflict', '该设备身份已有另一个运行中的实例'))
        }
        yield* sql`INSERT INTO node_presence (node_id, employee_id, online, synced, incarnation, conn_id, last_contact_at, status_updated_at)
      VALUES (${source.node_id}::uuid, ${source.employee_id}::uuid, true, false, ${source.incarnation}, ${source.conn_id}, clock_timestamp(), clock_timestamp())
      ON CONFLICT (node_id) DO UPDATE SET online=true,
        synced=CASE WHEN node_presence.conn_id=EXCLUDED.conn_id AND node_presence.incarnation=EXCLUDED.incarnation THEN node_presence.synced ELSE false END,
        incarnation=EXCLUDED.incarnation, conn_id=EXCLUDED.conn_id, last_contact_at=clock_timestamp(), status_updated_at=clock_timestamp()`
        yield* revalidateNodeSource(source, false)
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const syncNode = (source: NodeSource, input: SyncInput): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.try({ try: () => validateNode(input), catch: dbError })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // 节点写锁也让同一来源的同步与连接替换依次执行。
        const nodes =
          yield* sql`SELECT id FROM nodes WHERE id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid FOR UPDATE`
        if (!nodes[0]) return yield* Effect.fail(rejectedSource())
        yield* lockNodeSource(source, false)
        yield* sql`UPDATE nodes SET display_name=${input.display_name}, system_name=${input.system},
      capabilities=ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.capabilities ?? [])}::jsonb)) WHERE id=${source.node_id}::uuid`
        yield* sql`UPDATE node_presence SET synced=true, last_contact_at=clock_timestamp(), status_updated_at=clock_timestamp()
      WHERE node_id=${source.node_id}::uuid AND conn_id=${source.conn_id}`
        yield* revalidateNodeSource(source)
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const touchNode = (source: NodeSource): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // FOR UPDATE 避免两个心跳同时升级 Presence 的共享锁。
        yield* sql`SELECT id FROM nodes WHERE id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid FOR UPDATE`
        yield* lockNodeSource(source, false)
        yield* sql`UPDATE node_presence SET last_contact_at=clock_timestamp() WHERE node_id=${source.node_id}::uuid AND conn_id=${source.conn_id}`
        yield* revalidateNodeSource(source, false)
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const disconnectNode = (source: NodeSource): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE node_presence SET online=false, synced=false, status_updated_at=clock_timestamp()
    WHERE node_id=${source.node_id}::uuid AND employee_id=${source.employee_id}::uuid AND conn_id=${source.conn_id} AND incarnation=${source.incarnation}`
  }).pipe(Effect.mapError(dbError))

export const resetConnections = (): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE node_presence SET online=false, synced=false, status_updated_at=clock_timestamp() WHERE online OR synced`
  }).pipe(Effect.mapError(dbError))

export const saveRuntimeReport = (source: NodeSource, report: Record<string, unknown>): DatabaseEffect<number> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const raw = yield* Effect.try({
      try: () => JSON.stringify(Schema.decodeUnknownSync(RuntimeReport)(report)),
      catch: () => new AppError(400, 'invalid_runtime_report', '设备能力报告无效'),
    })
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockNodeSource(source)
        const rows = yield* sql<{
          report_version: number
        }>`INSERT INTO node_runtime_reports (node_id, employee_id, report_version, reported_at, report)
      VALUES (${source.node_id}::uuid, ${source.employee_id}::uuid, 1, clock_timestamp(), ${raw}::jsonb)
      ON CONFLICT (node_id) DO UPDATE SET report_version=node_runtime_reports.report_version+
        CASE WHEN node_runtime_reports.report=EXCLUDED.report THEN 0 ELSE 1 END, reported_at=clock_timestamp(), report=EXCLUDED.report
      RETURNING report_version::float8`
        yield* revalidateNodeSource(source)
        return rows[0].report_version
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const localProcessNotice = '吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。'
const revocationMessage = (status: string) =>
  status === 'effective' ? '吊销已生效。同一连接凭据不能再连接。' : '吊销正在处理，尚未生效。'

type NodeRow = {
  id: string
  display_name: string
  system: string
  capabilities: string[]
  registration_seq: number
  registered_at: Date
  revoked: boolean
  expired: boolean
  idle_expires_at: Date
  online: boolean
  synced: boolean
  last_contact_at: Date | null
  status_updated_at: Date | null
  runtime_report: Record<string, unknown> | null
  runtime_report_version: number
  runtime_reported_at: Date | null
  requested_at: Date | null
  applied_at: Date | null
  operator_id: string | null
  credential_ids: string[]
}

const nodeRows = (employeeId: string, nodeId?: string): DatabaseEffect<readonly NodeRow[]> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<NodeRow>`SELECT n.id::text, n.display_name, n.system_name AS system, n.capabilities,
    n.registration_seq::float8, n.registered_at, n.revoked_at IS NOT NULL AS revoked,
    c.expires_at<=clock_timestamp() AS expired,c.expires_at AS idle_expires_at,
    COALESCE(p.online,false) AS online, COALESCE(p.synced,false) AS synced, p.last_contact_at, p.status_updated_at,
    r.report AS runtime_report, COALESCE(r.report_version,0)::float8 AS runtime_report_version, r.reported_at AS runtime_reported_at,
    v.requested_at, v.applied_at, v.operator_id, COALESCE(v.credential_ids,ARRAY[]::text[]) AS credential_ids
    FROM nodes n JOIN node_credentials c ON c.node_id=n.id AND c.version=n.credential_version
    LEFT JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id
    LEFT JOIN node_runtime_reports r ON r.node_id=n.id AND r.employee_id=n.employee_id
    LEFT JOIN LATERAL (SELECT min(requested_at) AS requested_at,
      CASE WHEN bool_and(applied_at IS NOT NULL) THEN max(applied_at) ELSE NULL END AS applied_at,
      (array_agg(actor_employee_id::text ORDER BY requested_at, credential_id))[1] AS operator_id,
      array_agg(credential_id::text ORDER BY credential_id) AS credential_ids FROM node_revocations WHERE node_id=n.id AND employee_id=n.employee_id) v ON true
    WHERE n.employee_id=${employeeId}::uuid AND (${nodeId ?? null}::uuid IS NULL OR n.id=${nodeId ?? null}::uuid) ORDER BY n.registration_seq`
  }).pipe(Effect.mapError(dbError))

const revocationFrom = (row: NodeRow): Record<string, unknown> => {
  const status = row.revoked ? (row.applied_at ? 'effective' : 'pending') : 'none'
  return {
    node_id: row.id,
    status,
    operator_id: row.operator_id ?? '',
    credential_ids: row.credential_ids,
    requested_at: timestamp(row.requested_at),
    applied_at: timestamp(row.applied_at),
    message: status === 'none' ? '' : revocationMessage(status),
    local_process_notice: localProcessNotice,
  }
}

const nodeFrom = (row: NodeRow): Record<string, unknown> => ({
  id: row.id,
  display_name: row.display_name,
  system: row.system,
  capabilities: row.capabilities,
  registration_seq: row.registration_seq,
  registered_at: timestamp(row.registered_at),
  online: row.online,
  synced: row.synced,
  executable: row.online && row.synced && !row.revoked && !row.expired,
  credential_state: row.revoked ? 'revoked' : row.expired ? 'idle_expired' : 'active',
  idle_expires_at: timestamp(row.idle_expires_at),
  last_contact_at: timestamp(row.last_contact_at),
  status_updated_at: timestamp(row.status_updated_at),
  runtime_report: row.runtime_report,
  runtime_report_version: row.runtime_report_version,
  runtime_reported_at: timestamp(row.runtime_reported_at),
  ...(row.runtime_report?.batond_version ? { batond_version: row.runtime_report.batond_version } : {}),
  user: row.runtime_report?.user ?? '',
  revocation_status: row.revoked ? (row.applied_at ? 'effective' : 'pending') : 'none',
  ...(row.revoked ? { revocation: revocationFrom(row) } : {}),
})

const defaultState = (employeeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      node_id: string | null
      revoked: boolean
    }>`SELECT s.default_device_node_id::text AS node_id,
    COALESCE(n.revoked_at IS NOT NULL,false) AS revoked FROM employee_settings s LEFT JOIN nodes n
    ON n.id=s.default_device_node_id AND n.employee_id=s.employee_id WHERE s.employee_id=${employeeId}::uuid`
    const row = rows[0]
    return {
      node_id: row?.node_id ?? '',
      invalid: row?.revoked ?? false,
      needs_reselection: row?.revoked ?? false,
      ...(row?.revoked ? { message: '默认设备仍指向该节点，需要重新选择。' + localProcessNotice } : {}),
    }
  }).pipe(Effect.mapError(dbError))

export const listNodes = (employeeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const nodes = yield* nodeRows(employeeId),
      state = yield* defaultState(employeeId)
    return {
      nodes: nodes.map(nodeFrom),
      default_device: state,
      default_pc: state,
      local_process_notice: localProcessNotice,
    }
  })

export const getNode = (employeeId: string, nodeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    if (!uuidPattern.test(nodeId)) return yield* Effect.fail(new AppError(400, 'invalid_id', '设备标识无效'))
    const rows = yield* nodeRows(employeeId, nodeId)
    if (!rows[0]) return yield* Effect.fail(forbidden())
    return nodeFrom(rows[0])
  })

export const setDefaultDevice = (employeeId: string, nodeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!uuidPattern.test(nodeId)) return yield* Effect.fail(forbidden())
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO employee_settings (employee_id, updated_at) VALUES (${employeeId}::uuid, now()) ON CONFLICT DO NOTHING`
        yield* sql`SELECT employee_id FROM employee_settings WHERE employee_id=${employeeId}::uuid FOR UPDATE`
        const nodes = yield* sql<{
          id: string
          display_name: string
          system: string
          registration_seq: number
          revoked: boolean
        }>`
      SELECT id::text, display_name, system_name AS system, registration_seq::float8, revoked_at IS NOT NULL AS revoked
      FROM nodes WHERE id=${nodeId}::uuid AND employee_id=${employeeId}::uuid FOR SHARE`
        const node = nodes[0]
        if (!node) return yield* Effect.fail(forbidden())
        if (node.revoked) return yield* Effect.fail(new AppError(400, 'invalid_node', '该设备已不能作为默认设备'))
        yield* sql`UPDATE employee_settings SET default_device_node_id=${nodeId}::uuid, updated_at=now() WHERE employee_id=${employeeId}::uuid`
        return {
          default_device_node_id: node.id,
          default_pc_node_id: node.id,
          role: 'pc',
          display_name: node.display_name,
          system: node.system,
          registration_seq: node.registration_seq,
        }
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const revokeNode = (employeeId: string, nodeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!uuidPattern.test(nodeId)) return yield* Effect.fail(forbidden())
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const nodes =
          yield* sql`SELECT id FROM nodes WHERE id=${nodeId}::uuid AND employee_id=${employeeId}::uuid FOR UPDATE`
        if (!nodes[0]) return yield* Effect.fail(forbidden())
        const credentials = yield* sql<{
          id: string
        }>`UPDATE node_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE node_id=${nodeId}::uuid AND employee_id=${employeeId}::uuid RETURNING id::text`
        yield* sql`UPDATE nodes SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=${nodeId}::uuid`
        for (const credential of credentials) {
          yield* sql`INSERT INTO node_revocations (id, node_id, employee_id, actor_employee_id, credential_id, requested_at)
        VALUES (${randomUUID()}::uuid, ${nodeId}::uuid, ${employeeId}::uuid, ${employeeId}::uuid, ${credential.id}::uuid, clock_timestamp())
        ON CONFLICT (credential_id) DO NOTHING`
        }
        const rows = yield* nodeRows(employeeId, nodeId),
          state = yield* defaultState(employeeId)
        return { ...revocationFrom(rows[0]), default_device: state, default_pc: state }
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const getRevocation = (employeeId: string, nodeId: string): DatabaseEffect<Record<string, unknown>> =>
  Effect.gen(function* () {
    if (!uuidPattern.test(nodeId)) return yield* Effect.fail(forbidden())
    const rows = yield* nodeRows(employeeId, nodeId),
      state = yield* defaultState(employeeId)
    if (!rows[0]) return yield* Effect.fail(forbidden())
    return { ...revocationFrom(rows[0]), default_device: state, default_pc: state }
  })

export interface RevocationCursor {
  readonly requested_at: string
  readonly node_id: string
}

export interface PendingRevocation extends RevocationCursor {
  readonly employee_id: string
}

/** 按节点合并未完成的吊销意图；游标让失败批次之后的节点仍能被处理。 */
export const pendingRevocations = (
  limit = 32,
  after?: RevocationCursor,
): DatabaseEffect<readonly PendingRevocation[]> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 32 ||
      (after && (!uuidPattern.test(after.node_id) || !Number.isFinite(Date.parse(after.requested_at))))
    )
      return yield* Effect.fail(new AppError(400, 'invalid_revocation_page', '吊销扫描参数无效'))
    return yield* sql<PendingRevocation>`WITH pending AS (
      SELECT node_id,employee_id,min(requested_at) AS requested_at
      FROM node_revocations WHERE applied_at IS NULL GROUP BY node_id,employee_id
    ) SELECT node_id::text,employee_id::text,requested_at::text FROM pending
      WHERE (${after?.requested_at ?? null}::timestamptz IS NULL OR
        (requested_at,node_id)>(${after?.requested_at ?? null}::timestamptz,${after?.node_id ?? null}::uuid))
      ORDER BY requested_at,node_id LIMIT ${limit}`
  }).pipe(Effect.mapError(dbError))

/** Gateway 关闭连接并调用 disconnectNode 后确认吊销生效。 */
export const markRevocationApplied = (employeeId: string, nodeId: string): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const nodes =
          yield* sql`SELECT id FROM nodes WHERE id=${nodeId}::uuid AND employee_id=${employeeId}::uuid AND revoked_at IS NOT NULL FOR UPDATE`
        if (!nodes[0]) return yield* Effect.fail(forbidden())
        const active = yield* sql`SELECT node_id FROM node_presence WHERE node_id=${nodeId}::uuid AND online FOR UPDATE`
        if (active[0]) return yield* Effect.fail(new AppError(409, 'revocation_pending', '设备连接尚未关闭'))
        yield* sql`UPDATE node_revocations SET applied_at=COALESCE(applied_at,clock_timestamp()) WHERE node_id=${nodeId}::uuid AND employee_id=${employeeId}::uuid`
      }),
    )
  }).pipe(Effect.mapError(dbError))
