import childProcess from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Effect } from 'effect'
import * as Fiber from 'effect/Fiber'
import { hostProcessGroupScoped, installHostProcessGroup } from '../host-process-group.ts'

const role = process.argv[2]
if (role === 'leaf') {
  setInterval(() => {}, 1000)
} else if (role === 'branch') {
  const leaf = childProcess.spawn(process.execPath, [import.meta.filename, 'leaf'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  console.log(JSON.stringify({ branch: process.pid, leaf: leaf.pid }))
  if (process.argv[3] === 'orphan') process.exit(0)
  setInterval(() => {}, 1000)
} else if (role === 'shared') {
  const originalSpawn = childProcess.spawn
  const originalFork = childProcess.fork
  try {
    installHostProcessGroup()
    throw new Error('Shared group installation unexpectedly succeeded')
  } catch (error) {
    console.log(
      JSON.stringify({
        rejected: error.message,
        unchanged: childProcess.spawn === originalSpawn && childProcess.fork === originalFork,
      }),
    )
  }
} else if (role === 'scope') {
  const originalSpawn = childProcess.spawn
  let policy
  let cleanupInherited = false
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        policy = yield* hostProcessGroupScoped
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleanupInherited = childProcess.spawn !== originalSpawn
          }),
        )
        return yield* Effect.fail('host scope ended')
      }),
    ).pipe(Effect.flip),
  )
  let sealed = false
  try {
    childProcess.spawn(process.execPath, ['-e', ''])
  } catch {
    sealed = true
  }
  console.log(JSON.stringify({ result, cleanupInherited, keptGuard: childProcess.spawn !== originalSpawn, sealed }))
  policy.restore()
} else {
  const originalSpawn = childProcess.spawn
  const policy = installHostProcessGroup()
  const tools = new Map()
  const controllers = new Map()
  const fibers = new Map()
  const lines = createInterface({ input: process.stdin })
  const emit = (id, result) => console.log(JSON.stringify({ id, ...result }))
  const handle = async (request) => {
    const { id, action } = request
    try {
      if (action === 'tree') {
        const child = childProcess.spawn(
          process.execPath,
          [import.meta.filename, 'branch', ...(request.orphan ? ['orphan'] : [])],
          {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        tools.set(id, child)
        const output = createInterface({ input: child.stdout })
        const info = JSON.parse((await once(output, 'line'))[0])
        output.close()
        emit(id, { ...info, pgid: policy.pgid })
      } else if (action === 'kill-root') {
        const child = tools.get(request.tool)
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
        emit(id, { exited: true })
      } else if (action === 'terminate' || action === 'wait') {
        const controller = new AbortController()
        if (request.preAborted) controller.abort(new Error('termination cancelled'))
        controllers.set(id, controller)
        const options = { timeoutMs: request.timeoutMs ?? 2000, signal: controller.signal }
        if (request.effect) {
          const operation =
            action === 'wait' ? policy.waitQuiescentEffect(options) : policy.terminateChildrenEffect(options)
          await Effect.runPromise(operation)
        } else if (request.fiber) {
          const fiber = Effect.runFork(policy.waitQuiescentEffect(options))
          fibers.set(id, fiber)
          const exit = await Effect.runPromise(Fiber.await(fiber))
          emit(id, { fiberExit: exit._tag })
          return
        } else if (action === 'wait' && request.positionalSignal) {
          await policy.waitQuiescent(controller.signal)
        } else {
          await (action === 'wait' ? policy.waitQuiescent(options) : policy.terminateChildren(options))
        }
        emit(id, { quiet: true })
      } else if (action === 'cancel') {
        controllers.get(request.target).abort(new Error('wait cancelled'))
        emit(id, { cancelled: true })
      } else if (action === 'interrupt') {
        await Effect.runPromise(Fiber.interrupt(fibers.get(request.target)))
        emit(id, { interrupted: true })
      } else if (action === 'late-spawn') {
        let rejected = false
        try {
          childProcess.spawn(process.execPath, ['-e', ''], { detached: true })
        } catch {
          rejected = true
        }
        emit(id, { rejected, guardKept: childProcess.spawn !== originalSpawn })
      } else if (action === 'ping') {
        emit(id, { alive: true })
      }
    } catch (error) {
      emit(id, { error: error._tag ?? error.name, message: error.message })
    } finally {
      controllers.delete(id)
      fibers.delete(id)
    }
  }
  lines.on('line', (line) => {
    void handle(JSON.parse(line))
  })
  console.log(JSON.stringify({ ready: true, pgid: policy.pgid }))
}
