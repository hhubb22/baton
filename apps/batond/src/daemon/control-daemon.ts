import { randomBytes } from 'node:crypto'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Effect, Exit, Schema, type Scope } from 'effect'
import { BUILD, PROTOCOL_VERSION } from '@baton/protocol/release'
import { UUID, type NodeIdentity } from '@baton/protocol'
import { acquireProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { readOwnProcessIdentity } from '../platform/identity.ts'
import { clearIdentity, coordinatorURL, isMissing, loadIdentity } from './identity.ts'
import {
  controlPaths,
  decodeControlRequest,
  decodeControlResponse,
  type ConnectionState,
  type ControlResponse,
  type ControlRequest,
} from './control.ts'
import { DeviceLogin } from './device-login.ts'
import { listenAuthenticated, IPCError } from './ipc.ts'
import { stopManagedProcesses } from './daemon-shutdown.ts'
import { loadBindingFence, retireBinding } from './binding-fence.ts'
import type { RunDaemonOptions } from './daemon.ts'

const failure = (error: unknown): Error => (error instanceof Error ? error : new Error('本机守护进程操作失败'))
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })
const ErrorSummary = Schema.Struct({ code: Schema.String, message: Schema.String, at: Schema.String })

export const runControlDaemon = Effect.fnUntraced(function* (
  options: RunDaemonOptions,
  bound: (
    identity: NodeIdentity,
    onState: (state: ConnectionState) => Promise<void>,
  ) => Effect.Effect<void, Error, Scope.Scope>,
): Effect.fn.Return<void, Error, Scope.Scope> {
  if (process.platform !== 'win32') process.umask(0o077)
  const paths = controlPaths(options.dataDirectory)
  yield* attempt(() => ensurePrivateDirectory(paths.root))
  yield* Effect.acquireRelease(
    attempt(() => acquireProcessLock(join(paths.root, 'daemon.lock'))),
    (release) => attempt(release).pipe(Effect.orDie),
  )
  const run = Effect.runPromiseExitWith(yield* Effect.context<never>())
  let identity =
    options.identity ??
    (yield* attempt(async () => {
      try {
        return await loadIdentity(paths.root)
      } catch (error) {
        if (isMissing(error)) return undefined
        throw error
      }
    }))
  let state: ConnectionState = identity ? 'connecting' : 'unbound'
  let rejection: ControlResponse['rejection']
  let lastError: ControlResponse['last_error']
  let controller: AbortController | undefined
  let runtime: Promise<void> | undefined
  let serial: Promise<unknown> = Promise.resolve()
  let closing = false
  const stopped = Promise.withResolvers<void>()
  const rejectionFile = join(paths.root, 'control-state.json')
  if (identity)
    yield* attempt(async () => {
      try {
        const saved = Schema.decodeUnknownSync(
          Schema.Struct({
            rejection: ErrorSummary,
            node_id: UUID,
            coordinator_url: Schema.NullOr(Schema.String),
            batond_version: Schema.String,
            protocol_version: Schema.Int,
          }),
        )(JSON.parse((await readPrivateFile(rejectionFile)).toString('utf8')))
        if (saved.node_id !== identity!.node_id || saved.coordinator_url !== (identity!.coordinator_url ?? null)) {
          await unlink(rejectionFile)
        } else if (
          saved.rejection.code !== 'node_version_incompatible' ||
          (saved.batond_version === BUILD.version && saved.protocol_version === PROTOCOL_VERSION)
        ) {
          rejection = saved.rejection
          state = 'rejected'
        } else await unlink(rejectionFile)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    })
  const bindingFence = yield* attempt(() => loadBindingFence(paths.root))
  if (identity && bindingFence.node_ids.includes(identity.node_id)) {
    rejection = {
      code: 'binding_retired',
      message: '本机绑定正在解除，请完成 batond logout 后重新登录',
      at: new Date().toISOString(),
    }
    state = 'rejected'
  }
  const saveStatus = async (stopping = false) => {
    const own = await readOwnProcessIdentity()
    await writePrivateFileAtomic(
      join(paths.root, 'daemon-status.json'),
      JSON.stringify({
        pid: process.pid,
        ...(own ? { creation_time: own.creationTime } : {}),
        batond_version: BUILD.version,
        environment_revision: process.env.BATON_ENV_REVISION ?? '',
        state: stopping ? 'stopping' : state,
        ...(rejection ? { code: rejection.code, message: rejection.message } : {}),
        updated_at: new Date().toISOString(),
      }),
    )
  }
  let statusWrite: Promise<void> = Promise.resolve()
  const setState = (next: ConnectionState): Promise<void> => {
    state = next
    statusWrite = statusWrite.then(() => saveStatus())
    return statusWrite
  }
  const rejectRuntime = async (cause: Error) => {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : 'daemon_runtime_failed'
    rejection = { code, message: cause.message, at: new Date().toISOString() }
    await writePrivateFileAtomic(
      rejectionFile,
      JSON.stringify({
        rejection,
        node_id: identity!.node_id,
        coordinator_url: identity!.coordinator_url ?? null,
        batond_version: BUILD.version,
        protocol_version: PROTOCOL_VERSION,
      }),
    )
    await setState('rejected')
  }
  const startBound = () => {
    if (!identity || runtime || closing || rejection) return
    controller = new AbortController()
    const current = controller
    const start = options.boundRuntime ?? bound
    runtime = run(
      Effect.scoped(
        start(identity, async (next) => {
          if (!current.signal.aborted && controller === current) await setState(next)
        }),
      ),
      { signal: current.signal },
    ).then(async (exit) => {
      if (Exit.isSuccess(exit)) {
        if (!current.signal.aborted) stopped.resolve()
        return
      }
      if (current.signal.aborted) {
        if (!Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause)
        return
      }
      await rejectRuntime(failure(Cause.squash(exit.cause)))
    })
    // Keep cleanup failures observed even when no controller is currently waiting for shutdown.
    runtime.catch(() => undefined)
  }
  const stopBound = async () => {
    controller?.abort()
    await runtime
    controller = undefined
    runtime = undefined
  }
  const login = new DeviceLogin({
    dataDirectory: paths.root,
    ...(options.deviceLoginTransport ? { transport: options.deviceLoginTransport } : {}),
    onApproved: async (saved) => {
      identity = saved
      lastError = undefined
      await setState('connecting')
      startBound()
    },
    onFinished: async (code) => {
      lastError = code
        ? {
            code,
            message: code === 'login_expired' ? '设备登录已过期，请重新登录' : '设备登录未完成，请重新登录',
            at: new Date().toISOString(),
          }
        : undefined
      await setState('unbound')
    },
  })
  const cleanup = async () => {
    await login.cancel()
    await stopBound()
    await stopManagedProcesses(paths.root)
  }
  yield* Effect.addFinalizer(() =>
    attempt(async () => {
      closing = true
      await serial
      await cleanup()
      await statusWrite
      await saveStatus(true)
    }).pipe(Effect.orDie),
  )
  yield* attempt(async () => {
    await ensurePrivateDirectory(join(paths.root, 'ipc'))
    await ensurePrivateDirectory(paths.ipcDirectory)
    if (process.platform !== 'win32') {
      try {
        const socket = await lstat(paths.endpoint)
        if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('本机控制端点不安全')
        await unlink(paths.endpoint)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    await writePrivateFileAtomic(paths.token, randomBytes(32).toString('hex'))
  })
  const status = async (): Promise<ControlResponse> => {
    const { isUserServiceInstalled } = await import('./service.ts')
    return {
      ok: true,
      pid: process.pid,
      batond_version: BUILD.version,
      protocol_version: PROTOCOL_VERSION,
      platform: process.platform,
      state,
      ...(identity
        ? {
            coordinator_url: identity.coordinator_url,
            node_id: identity.node_id,
            employee_id: identity.employee_id,
            display_name: identity.display_name,
          }
        : {}),
      ...(rejection ? { rejection } : {}),
      ...(lastError ? { last_error: lastError } : {}),
      ...(login.pending ? { pending_login: login.pending } : {}),
      service_installed: await isUserServiceInstalled(paths.root),
    }
  }
  const currentIdentity = (): NodeIdentity | undefined => identity
  const handle = async (request: ControlRequest): Promise<ControlResponse> => {
    if (request.method === 'status') return status()
    if (closing) return { ok: false, code: 'daemon_stopping', message: '守护进程正在停止' }
    if (request.method === 'login_start') {
      const base = coordinatorURL(request.coordinator_url)
      if (identity) {
        if (identity.coordinator_url !== base || rejection)
          return {
            ok: false,
            code: 'logout_required',
            message: `本机已绑定 ${identity.coordinator_url ?? '中心'}，请先执行 batond logout 后重新登录`,
          }
        startBound()
        return { ...(await status()), status: 'already_bound' }
      }
      if (login.pending) {
        await login.cancel()
        const afterCancellation = currentIdentity()
        if (afterCancellation) {
          if (afterCancellation.coordinator_url !== base || rejection)
            return { ok: false, code: 'logout_required', message: '本机已有绑定，请先执行 batond logout 后重新登录' }
          return { ...(await status()), status: 'already_bound' }
        }
      }
      try {
        const pending = await login.start(base, request.display_name)
        lastError = undefined
        await setState('authorizing')
        return { ok: true, ...pending }
      } catch (error) {
        await setState('unbound')
        throw error
      }
    }
    if (request.method === 'login_cancel') {
      await login.cancel()
      if (!identity) await setState('unbound')
      return { ok: true }
    }
    if (request.method === 'logout' || request.method === 'shutdown') {
      closing = request.method === 'shutdown'
      await cleanup()
      if (request.method === 'logout') {
        if (identity) await retireBinding(paths.root, identity.node_id)
        await clearIdentity(paths.root)
        identity = undefined
        rejection = undefined
        lastError = undefined
        await unlink(rejectionFile).catch((error: unknown) => {
          if (!isMissing(error)) throw error
        })
        await setState('unbound')
      }
      return { ok: true }
    }
    if (request.method === 'diagnostics') return status()
    return { ok: false, code: 'unsupported', message: '本机控制方法尚不支持' }
  }
  yield* listenAuthenticated({
    endpoint: paths.endpoint,
    token: (yield* attempt(() => readPrivateFile(paths.token))).toString('utf8'),
    decodeRequest: decodeControlRequest,
    decodeResponse: decodeControlResponse,
    handle: (request) =>
      attempt(async () => {
        // Status never queues behind a network-bound login or a long process cleanup.
        if (request.method === 'status') return status()
        const task = serial.then(() => handle(request))
        serial = task.catch(() => undefined)
        try {
          return await task
        } catch (error) {
          return {
            ok: false,
            code: error instanceof IPCError ? error.code : 'control_failed',
            message: failure(error).message,
          }
        }
      }),
    onResponse: (request, response) => {
      if (request.method === 'shutdown' && response.ok) stopped.resolve()
    },
  })
  if (process.platform !== 'win32') yield* attempt(() => chmod(paths.endpoint, 0o600))
  yield* attempt(() => saveStatus())
  startBound()
  yield* attempt(() => stopped.promise)
})
