import { argon2, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { type DatabaseEffect, dbError } from './database.ts'
import { AppError } from './errors.ts'

export interface Employee {
  readonly id: string
  readonly username: string
  readonly display_name: string
  readonly auth_source: string
  readonly must_change_password: boolean
}

export interface Session {
  readonly id: string
  readonly employee: Employee
  readonly csrf_token: string
  readonly csrf_hash: Uint8Array
  readonly expires_at: string
}

export interface LoginResult {
  readonly employee: Employee
  readonly csrf_token: string
  readonly expires_at: string
  readonly token: string
}

type Credential = Employee & { password_hash: string }
const usernamePattern = /^[a-z][a-z0-9._-]{0,62}$/
export const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
export const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
export const sessionCSRF = (token: string): string => digest(`baton:session-csrf:v1\0${token}`).toString('base64url')
export const newSecret = (): string => randomBytes(32).toString('base64url')
const employeeFrom = (row: Employee): Employee => ({
  id: row.id,
  username: row.username,
  display_name: row.display_name,
  auth_source: row.auth_source,
  must_change_password: row.must_change_password,
})

function validatePassword(password: string, username: string): void {
  if (
    Array.from(password).length < 12 ||
    Array.from(password).length > 128 ||
    hasControlCharacters(password) ||
    password.trim() !== password ||
    password.toLowerCase() === username.toLowerCase()
  ) {
    throw new AppError(400, 'invalid_password', '口令需要 12 到 128 个字符，不能与用户名相同或包含控制字符及首尾空格')
  }
}

const derive = (
  password: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
  tagLength: number,
) =>
  new Promise<Buffer>((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        memory,
        passes,
        parallelism,
        tagLength,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  )

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, 19456, 2, 1, 32)
  return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${hash.toString('base64').replace(/=+$/, '')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded)
  if (!match) return false
  const [, memoryRaw, passesRaw, parallelRaw, saltRaw, hashRaw] = match
  const [memory, passes, parallelism] = [Number(memoryRaw), Number(passesRaw), Number(parallelRaw)]
  const salt = Buffer.from(saltRaw, 'base64'),
    hash = Buffer.from(hashRaw, 'base64')
  if (
    memory < 8192 ||
    memory > 1048576 ||
    passes < 1 ||
    passes > 8 ||
    parallelism < 1 ||
    parallelism > 8 ||
    salt.length < 8 ||
    salt.length > 64 ||
    hash.length < 16 ||
    hash.length > 64
  )
    return false
  const actual = await derive(password, salt, memory, passes, parallelism, hash.length)
  return timingSafeEqual(actual, hash)
}

let dummyHash: Promise<string> | undefined

export const createEmployee = (username: string, displayName: string, password: string): DatabaseEffect<Employee> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const display = displayName.trim()
    yield* Effect.try({
      try: () => {
        if (
          !usernamePattern.test(username) ||
          Array.from(display).length < 1 ||
          Array.from(display).length > 80 ||
          hasControlCharacters(display)
        ) {
          throw new AppError(400, 'invalid_employee', '用户名或显示名无效')
        }
        validatePassword(password, username)
      },
      catch: dbError,
    })
    const hash = yield* Effect.tryPromise({ try: () => hashPassword(password), catch: dbError })
    const rows = yield* sql<Employee>`INSERT INTO employees
      (id, username, display_name, auth_source, password_hash, must_change_password, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${username}, ${display}, 'local', ${hash}, true, now(), now())
      ON CONFLICT (username) DO NOTHING RETURNING id::text, username, display_name, auth_source, must_change_password`
    if (!rows[0]) return yield* Effect.fail(new AppError(409, 'username_taken', '用户名已存在'))
    return employeeFrom(rows[0])
  }).pipe(Effect.mapError(dbError))

/** CLI 调用方只向操作者输出一次性口令。 */
export const initializeEmployee = (
  username: string,
  displayName: string,
): DatabaseEffect<{ employee: Employee; password: string }> =>
  Effect.gen(function* () {
    const password = newSecret().slice(0, 24)
    const employee = yield* createEmployee(username, displayName, password)
    return { employee, password }
  })

export const login = (username: string, password: string, ttlSeconds = 43200): DatabaseEffect<LoginResult> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (password.length > 1024 || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2592000) {
      return yield* Effect.fail(new AppError(401, 'invalid_credentials', '用户名或口令不正确'))
    }
    const rows =
      yield* sql<Credential>`SELECT id::text, username, display_name, auth_source, must_change_password, password_hash
      FROM employees WHERE username=${username} AND auth_source='local'`
    const cred = rows[0]
    const hash =
      cred?.password_hash ??
      (yield* Effect.tryPromise({
        try: () => (dummyHash ??= hashPassword(newSecret())),
        catch: dbError,
      }))
    const valid = yield* Effect.tryPromise({ try: () => verifyPassword(password, hash), catch: dbError })
    if (!cred || !valid) return yield* Effect.fail(new AppError(401, 'invalid_credentials', '用户名或口令不正确'))
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current =
          yield* sql<Credential>`SELECT id::text, username, display_name, auth_source, must_change_password, password_hash
        FROM employees WHERE id=${cred.id}::uuid FOR UPDATE`
        if (current[0]?.password_hash !== hash) {
          return yield* Effect.fail(new AppError(401, 'invalid_credentials', '用户名或口令不正确'))
        }
        const token = newSecret(),
          csrf = sessionCSRF(token)
        const saved = yield* sql<{ expires_at: Date }>`INSERT INTO login_sessions
        (id, employee_id, token_hash, csrf_hash, created_at, expires_at)
        VALUES (${randomUUID()}::uuid, ${cred.id}::uuid, ${digest(token)}, ${digest(csrf)}, now(),
          clock_timestamp() + ${ttlSeconds} * interval '1 second') RETURNING expires_at`
        return {
          employee: employeeFrom(current[0]),
          csrf_token: csrf,
          token,
          expires_at: saved[0].expires_at.toISOString(),
        }
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const lookupSession = (token: string): DatabaseEffect<Session> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token))
      return yield* Effect.fail(new AppError(401, 'unauthenticated', '请先登录'))
    const rows = yield* sql<
      Employee & { session_id: string; csrf_hash: Uint8Array; expires_at: Date; expired: boolean; revoked: boolean }
    >`
    SELECT e.id::text, e.username, e.display_name, e.auth_source, e.must_change_password,
      s.id::text AS session_id, s.csrf_hash, s.expires_at, s.expires_at<=clock_timestamp() AS expired,
      s.revoked_at IS NOT NULL AS revoked
    FROM login_sessions s JOIN employees e ON e.id=s.employee_id WHERE s.token_hash=${digest(token)}`
    const row = rows[0]
    if (!row || row.revoked) return yield* Effect.fail(new AppError(401, 'unauthenticated', '请先登录'))
    if (row.expired) return yield* Effect.fail(new AppError(401, 'session_expired', '登录已过期，请重新登录'))
    return {
      id: row.session_id,
      employee: employeeFrom(row),
      csrf_token: sessionCSRF(token),
      csrf_hash: row.csrf_hash,
      expires_at: row.expires_at.toISOString(),
    }
  }).pipe(Effect.mapError(dbError))

export const checkCSRF = (session: Session, supplied: string): boolean =>
  supplied.length <= 200 && timingSafeEqual(Buffer.from(session.csrf_hash), digest(supplied))

export const logout = (token: string): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE login_sessions SET revoked_at=now() WHERE token_hash=${digest(token)} AND revoked_at IS NULL`
  }).pipe(Effect.mapError(dbError))

export const changePassword = (
  employeeId: string,
  currentPassword: string,
  newPassword: string,
): DatabaseEffect<Employee> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      yield* sql<Credential>`SELECT id::text, username, display_name, auth_source, must_change_password, password_hash
      FROM employees WHERE id=${employeeId}::uuid AND auth_source='local'`
    const cred = rows[0]
    if (
      !cred ||
      currentPassword.length > 1024 ||
      !(yield* Effect.tryPromise({ try: () => verifyPassword(currentPassword, cred.password_hash), catch: dbError }))
    ) {
      return yield* Effect.fail(new AppError(401, 'invalid_credentials', '当前口令不正确'))
    }
    yield* Effect.try({
      try: () => {
        validatePassword(newPassword, cred.username)
        if (newPassword === currentPassword) throw new AppError(400, 'password_reused', '新口令不能与当前口令相同')
      },
      catch: dbError,
    })
    const hash = yield* Effect.tryPromise({ try: () => hashPassword(newPassword), catch: dbError })
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql<Employee>`UPDATE employees SET password_hash=${hash}, must_change_password=false,
        password_changed_at=now(), updated_at=now() WHERE id=${employeeId}::uuid AND password_hash=${cred.password_hash}
        RETURNING id::text, username, display_name, auth_source, must_change_password`
        if (!updated[0]) return yield* Effect.fail(new AppError(409, 'credential_changed', '口令已更改，请重新登录'))
        yield* sql`UPDATE login_sessions SET revoked_at=now() WHERE employee_id=${employeeId}::uuid AND revoked_at IS NULL`
        return employeeFrom(updated[0])
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const resetPassword = (username: string): DatabaseEffect<{ employee: Employee; password: string }> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const password = newSecret().slice(0, 24)
    const hash = yield* Effect.tryPromise({ try: () => hashPassword(password), catch: dbError })
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<Employee>`UPDATE employees SET password_hash=${hash}, must_change_password=true,
        password_changed_at=NULL, updated_at=now() WHERE username=${username} AND auth_source='local'
        RETURNING id::text, username, display_name, auth_source, must_change_password`
        if (!rows[0]) return yield* Effect.fail(new AppError(404, 'not_found', '找不到该本地账号'))
        yield* sql`UPDATE login_sessions SET revoked_at=now() WHERE employee_id=${rows[0].id}::uuid AND revoked_at IS NULL`
        return { employee: employeeFrom(rows[0]), password }
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const sessionCookie = (token: string, expiresAt: string): string =>
  `baton_session=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}; Secure; HttpOnly; SameSite=Strict`
export const clearSessionCookie = (): string =>
  'baton_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Strict'
