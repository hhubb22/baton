import childProcess from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { readProcessIdentity, systemCommand } from './identity.ts'

const fixture = fileURLToPath(new URL('./test-fixtures/group-host.mjs', import.meta.url))
const children: { child: childProcess.ChildProcess; grouped: boolean }[] = []
afterEach(async () => {
  for (const { child, grouped } of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    try {
      if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {}
    await exited
  }
})

function launch(role = 'host', grouped = true) {
  const child = childProcess.spawn(process.execPath, [fixture, role], {
    detached: grouped,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push({ child, grouped })
  child.stderr.resume()
  return child
}
async function host() {
  const child = launch()
  const lines = createInterface({ input: child.stdout })
  const replies = new Map<number, Record<string, unknown>>()
  const pending = new Map<number, (result: Record<string, unknown>) => void>()
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  lines.on('line', (line) => {
    const value = JSON.parse(line)
    if (value.ready) ready()
    else {
      replies.set(value.id, value)
      pending.get(value.id)?.(value)
      pending.delete(value.id)
    }
  })
  let next = 1
  const begin = (action: string, options: Record<string, unknown> = {}) => {
    const id = next++
    const result = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ id, action, ...options })}\n`)
    return { id, result }
  }
  await started
  return {
    pid: child.pid!,
    begin,
    replies,
    request: (action: string, options?: Record<string, unknown>) => begin(action, options).result,
  }
}
async function gone(pids: readonly number[]) {
  const deadline = performance.now() + 3000
  while ((await Promise.all(pids.map(readProcessIdentity))).some(Boolean)) {
    if (performance.now() > deadline) throw new Error('Tool processes still executing')
    await delay(20)
  }
}

describe.skipIf(process.platform === 'win32')('host group policy processes', () => {
  it('rejects an actual shared parent group without changing spawn or fork', async () => {
    const child = launch('shared', false)
    const lines = createInterface({ input: child.stdout })
    const result = JSON.parse((await once(lines, 'line'))[0])
    expect(result).toEqual({ rejected: 'Host must lead its own exclusive process group', unchanged: true })
  })

  it('keeps the guard sealed after Scope failure and through SDK resource cleanup', async () => {
    const child = launch('scope')
    const lines = createInterface({ input: child.stdout })
    const result = JSON.parse((await once(lines, 'line'))[0])
    expect(result).toEqual({ result: 'host scope ended', cleanupInherited: true, keptGuard: true, sealed: true })
  })

  it('excludes concurrent inspectors from terminate and quiescence checks', async () => {
    const current = await host()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        current.request(index % 2 ? 'terminate' : 'wait', { effect: index % 3 === 0 }),
      ),
    )
    for (const result of results) expect(result.quiet).toBe(true)
    expect((await current.request('ping')).alive).toBe(true)
  })

  it('clears SDK fallback orphans during concurrent wait while another Thread survives', async () => {
    const current = await host()
    const outsider = childProcess.spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    children.push({ child: outsider, grouped: true })
    const tool = current.begin('tree')
    const tree = await tool.result
    const branch = Number(tree.branch)
    const leaf = Number(tree.leaf)
    expect(
      (await systemCommand('/bin/ps', ['-p', `${branch},${leaf}`, '-o', 'pgid='])).split(/\s+/).map(Number),
    ).toEqual([current.pid, current.pid])
    await current.request('kill-root', { tool: tool.id })
    await gone([branch])
    expect(await readProcessIdentity(leaf)).not.toBeNull()
    const waiting = current.begin('wait', { effect: true })
    await current.request('ping')
    expect(current.replies.has(waiting.id)).toBe(false)
    const terminated = await current.request('terminate', { effect: true })
    expect(terminated.quiet).toBe(true)
    expect((await waiting.result).quiet).toBe(true)
    await gone([branch, leaf])
    expect(await readProcessIdentity(outsider.pid!)).not.toBeNull()
    expect((await current.request('late-spawn')).rejected).toBe(true)
    expect((await current.request('ping')).alive).toBe(true)
  })

  it('waits for an orphan holding background FDs after its normal parent exits', async () => {
    const current = await host()
    const tree = await current.request('tree', { orphan: true })
    const leaf = Number(tree.leaf)
    await gone([Number(tree.branch)])
    const waiting = current.begin('wait')
    await current.request('ping')
    expect(current.replies.has(waiting.id)).toBe(false)
    expect(await readProcessIdentity(leaf)).not.toBeNull()
    process.kill(leaf, 'SIGKILL')
    expect((await waiting.result).quiet).toBe(true)
  })

  it('reports timeout, AbortSignal cancellation and Effect interruption without ending live tools', async () => {
    const current = await host()
    const tree = await current.request('tree', { orphan: true })
    const leaf = Number(tree.leaf)
    const timedOut = await current.request('wait', { timeoutMs: 100 })
    expect(timedOut.error).toBe('PlatformError')
    expect(await readProcessIdentity(leaf)).not.toBeNull()
    const waiting = current.begin('wait', { positionalSignal: true })
    await current.request('ping')
    await current.request('cancel', { target: waiting.id })
    expect((await waiting.result).error).toBe('PlatformError')
    const interrupted = current.begin('wait', { fiber: true })
    await current.request('ping')
    await current.request('interrupt', { target: interrupted.id })
    expect((await interrupted.result).fiberExit).toBe('Failure')
    expect(await readProcessIdentity(leaf)).not.toBeNull()
    expect((await current.request('terminate')).quiet).toBe(true)
    await gone([leaf])
  })

  it('keeps late spawning sealed after cancelled termination and permits cleanup retry', async () => {
    const current = await host()
    const tree = await current.request('tree', { orphan: true })
    const result = await current.request('terminate', { preAborted: true })
    expect(result.error).toBe('PlatformError')
    expect(await readProcessIdentity(Number(tree.leaf))).not.toBeNull()
    expect((await current.request('late-spawn')).rejected).toBe(true)
    expect((await current.request('terminate')).quiet).toBe(true)
    await gone([Number(tree.leaf)])
  })
})
