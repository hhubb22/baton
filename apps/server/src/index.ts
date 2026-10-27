import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import { createDatabaseRuntime, migrateDatabase } from './database.ts'
import { initializeEmployee, resetPassword } from './auth.ts'
import { loadSigningKey, resetConnections } from './nodes.ts'
import { startServer } from './server.ts'
import { AppError } from './errors.ts'
import { controlConfiguration, duration } from './server-config.ts'

const usage = `Baton Coordinator（TypeScript 开发入口）

  serve
  migrate
  admin employee create --username <用户名> --display-name <显示名>
  admin employee reset-password --username <用户名>

配置：BATON_DATABASE_URL、BATON_DB_SCHEMA、BATON_HTTP_ADDR、BATON_ALLOWED_ORIGINS、
BATON_NODE_SIGNING_KEY、BATON_TLS_CERT_FILE、BATON_TLS_KEY_FILE。
网页目录由 BATON_WEB_DIR 指定，默认使用 bundle 旁的 web 目录。
控制预算：BATON_CONTROL_<操作>_QUEUE_TIMEOUT、BATON_CONTROL_<操作>_EXECUTION_TIMEOUT。
临时 RPC：BATON_RPC_READ_CONCURRENCY、BATON_RPC_MANAGEMENT_CONCURRENCY、
BATON_RPC_MAX_QUEUED、BATON_RPC_QUEUE_TIMEOUT、BATON_RPC_READ_TIMEOUT、
BATON_RPC_MANAGEMENT_TIMEOUT、BATON_RPC_LOGIN_TIMEOUT。配置范围见 apps/server/README.md。`

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log(usage)
    return
  }
  const url = process.env.BATON_DATABASE_URL?.trim()
  if (!url) throw new AppError(400, 'database_required', '需要设置 BATON_DATABASE_URL')
  const runtime = createDatabaseRuntime(
    { url, schema: process.env.BATON_DB_SCHEMA?.trim() || 'public' },
    telemetryLayer('baton-server'),
  )
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const run = async <A>(task: import('./database.ts').DatabaseEffect<A>): Promise<A> => {
      const result = await runtime.runPromiseExit(task, { signal: controller.signal })
      if (Exit.isSuccess(result)) return result.value
      throw Cause.squash(result.cause)
    }
    const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
    await run(migrateDatabase(migrationDirectory))
    if (args[0] === 'migrate' && args.length === 1) return
    if (args[0] === 'admin' && args[1] === 'employee' && ['create', 'reset-password'].includes(args[2])) {
      const { values } = parseArgs({
        args: args.slice(3),
        options: {
          username: { type: 'string' },
          'display-name': { type: 'string' },
        },
      })
      if (!values.username) throw new AppError(400, 'username_required', '需要 --username')
      if (args[2] === 'create' && !values['display-name'])
        throw new AppError(400, 'display_name_required', '需要 --display-name')
      const result =
        args[2] === 'create'
          ? await run(initializeEmployee(values.username, values['display-name']!))
          : await run(resetPassword(values.username))
      console.log(`用户名：${result.employee.username}\n一次性口令：${result.password}`)
      return
    }
    if (args[0] !== 'serve' || args.length !== 1) throw new AppError(400, 'invalid_command', usage)
    const origins = (process.env.BATON_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (
      !origins.length ||
      origins.some((value) => {
        try {
          const origin = new URL(value)
          return origin.protocol !== 'https:' || origin.origin !== value
        } catch {
          return true
        }
      })
    )
      throw new AppError(400, 'invalid_origins', 'BATON_ALLOWED_ORIGINS 需要配置 HTTPS Origin')
    const address = new URL(`http://${process.env.BATON_HTTP_ADDR?.trim() || '127.0.0.1:8080'}`)
    const certFile = process.env.BATON_TLS_CERT_FILE,
      keyFile = process.env.BATON_TLS_KEY_FILE
    if (Boolean(certFile) !== Boolean(keyFile)) throw new AppError(400, 'invalid_tls', 'TLS 证书与私钥需要同时设置')
    const tls =
      certFile && keyFile
        ? { cert: await readFile(certFile), key: await readFile(keyFile), minVersion: 'TLSv1.2' as const }
        : undefined
    const heartbeatMs = duration('BATON_HEARTBEAT_INTERVAL', 10_000, 100, 120_000)
    const offlineMs = duration('BATON_OFFLINE_AFTER', 30_000, 200, 600_000)
    const sessionTTLSeconds = duration('BATON_SESSION_TTL', 43_200_000, 300_000, 604_800_000) / 1000
    const enrollmentTTLSeconds = duration('BATON_ENROLLMENT_TTL', 600_000, 60_000, 86_400_000) / 1000
    if (offlineMs <= heartbeatMs) throw new AppError(400, 'invalid_configuration', '离线期限需要大于心跳间隔')
    const budgets = controlConfiguration()
    const signer = await loadSigningKey(process.env.BATON_NODE_SIGNING_KEY || 'node-signing.key')
    await run(resetConnections())
    const program = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startServer({
          ...budgets,
          host: address.hostname.replace(/^\[|\]$/g, ''),
          port: Number(address.port || 80),
          allowedOrigins: origins,
          signer,
          heartbeatMs,
          offlineMs,
          sessionTTLSeconds,
          enrollmentTTLSeconds,
          webDirectory: process.env.BATON_WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), 'web'),
          ...(tls ? { tls } : {}),
        })
        console.log(JSON.stringify({ event: 'listening', host: server.host, port: server.port }))
        yield* Effect.never
      }),
    )
    await runtime.runPromise(program, { signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await runtime.dispose()
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      ok: false,
      code: error instanceof AppError ? error.code : 'server_failed',
      message: error instanceof AppError ? error.message : 'Coordinator 启动失败',
    }),
  )
  process.exitCode = 1
})
