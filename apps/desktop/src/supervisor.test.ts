import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Supervisor, restartDecision } from './supervisor.ts'
import { fakeProcess } from './testing/process.ts'
import { redactDiagnostics } from './diagnostics.ts'

afterEach(() => vi.useRealTimers())
function fixture(now?: () => number) {
  vi.useFakeTimers()
  const children: ReturnType<typeof fakeProcess>[] = []
  const spawn = vi.fn(() => {
    const child = fakeProcess()
    children.push(child)
    return child
  })
  const changed = vi.fn()
  const supervisor = new Supervisor({ spawn, changed, log: vi.fn(), ...(now ? { now } : {}) })
  return { children, spawn, supervisor }
}

it('78 和终止类 stderr 不重启', async () => {
  for (const [exit, code, state] of [
    [78, '', 'rejected'],
    [1, 'needs_reauth', 'rejected'],
    [1, 'node_version_incompatible', 'rejected'],
    [1, 'deployment_invalid', 'rejected'],
  ] as const) {
    const f = fixture()
    f.supervisor.start()
    f.children[0]!.stderr.emit('data', Buffer.from(`diagnostic\n${JSON.stringify({ code })}\n`))
    f.children[0]!.emit('close', exit)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.supervisor.state.state).toBe(state)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    await f.supervisor.stop()
  }
})

it('异常退出按退避重启，60 秒内连续失败 5 次停止', async () => {
  const f = fixture()
  f.supervisor.start()
  for (const delay of [1000, 2000, 4000, 8000]) {
    const before = f.spawn.mock.calls.length
    f.children.at(-1)!.emit('close', 1)
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(f.spawn).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.spawn).toHaveBeenCalledTimes(before + 1)
  }
  f.children.at(-1)!.emit('close', 1)
  expect(f.supervisor.state.state).toBe('rejected')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.spawn).toHaveBeenCalledTimes(5)
  await f.supervisor.stop()
})

it('外部运行时每 30 秒尝试接管，停止监管不会操作外部进程', async () => {
  const f = fixture()
  f.supervisor.start()
  f.children[0]!.stderr.emit('data', Buffer.from('{"code":"daemon_running"}\n'))
  f.children[0]!.emit('close', 1)
  expect(f.supervisor.state.state).toBe('external')
  await vi.advanceTimersByTimeAsync(29_999)
  expect(f.spawn).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  f.children[1]!.stderr.emit('data', Buffer.from('{"code":"daemon_running"}\n'))
  f.children[1]!.emit('close', 1)
  await f.supervisor.stop()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.spawn).toHaveBeenCalledTimes(2)
})

it('退出时关闭 stdin，等待正常退出；超时才终止自己启动的进程', async () => {
  const f = fixture()
  f.supervisor.start()
  const first = f.children[0]!
  const kill = vi.spyOn(first, 'kill')
  const stopping = f.supervisor.stop()
  expect(first.stdin.writableEnded).toBe(true)
  await vi.advanceTimersByTimeAsync(14_999)
  expect(kill).not.toHaveBeenCalled()
  first.emit('close', 0)
  await stopping
  expect(kill).not.toHaveBeenCalled()
  await f.supervisor.restart()
  const secondKill = vi.spyOn(f.children[1]!, 'kill')
  const timeout = f.supervisor.stop()
  await vi.advanceTimersByTimeAsync(15_000)
  await timeout
  expect(secondKill).toHaveBeenCalledTimes(1)
  expect(f.supervisor.state.state).toBe('stopped')
})

it('客户端仍在运行时，daemon 的成功退出也会重新拉起', async () => {
  const f = fixture()
  f.supervisor.start()
  f.children[0]!.emit('close', 0)
  expect(f.supervisor.state.state).toBe('restarting')
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  const stopping = f.supervisor.stop()
  f.children[1]!.emit('close', 0)
  await stopping
})

it('重启等待超时后仍会在旧进程 close 后拉起新进程', async () => {
  const f = fixture()
  f.supervisor.start()
  const child = f.children[0]!
  vi.spyOn(child, 'kill').mockImplementation(() => true)
  const restart = f.supervisor.restart()
  await vi.advanceTimersByTimeAsync(15_000)
  await restart
  expect(f.spawn).toHaveBeenCalledTimes(1)
  child.emit('close', null)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  const stopping = f.supervisor.stop()
  f.children[1]!.emit('close', 0)
  await stopping
})

it('最近退出使用注入时间，保留 code、signal 和固定失败说明，并跨自动重启保留', async () => {
  let now = Date.parse('2026-06-01T12:00:00.000Z')
  const f = fixture(() => now)
  expect(f.supervisor.lastExit).toBeNull()
  f.supervisor.start()
  const message = 'connection refused; token=offline-diagnostic-value'
  f.children[0]!.stderr.emit('data', Buffer.from(JSON.stringify({ code: 'transport_failed', message })))
  now += 500
  f.children[0]!.emit('close', 17, 'SIGTERM')
  expect(f.supervisor.lastExit).toEqual({
    at: '2026-06-01T12:00:00.500Z',
    reason: 'batond exited (code: 17, signal: SIGTERM); batond reported a failure; check logs',
  })
  const exit = f.supervisor.lastExit
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  expect(f.supervisor.lastExit).toEqual(exit)
  const stopping = f.supervisor.stop()
  f.children[1]!.emit('close', 0, null)
  await stopping
})

it('正常退出、信号退出及普通 stderr 均记录实际结果，停止空监管不覆盖最近退出', async () => {
  const f = fixture()
  f.supervisor.start()
  f.children[0]!.emit('close', 0, null)
  expect(f.supervisor.lastExit?.reason).toBe('batond exited (code: 0, signal: none)')
  await vi.advanceTimersByTimeAsync(1000)
  f.children[1]!.stderr.emit('data', Buffer.from('ordinary diagnostic\nlast failure line\n'))
  f.children[1]!.emit('close', null, 'SIGABRT')
  expect(f.supervisor.lastExit?.reason).toBe(
    'batond exited (code: none, signal: SIGABRT); batond reported a failure; check logs',
  )
  const exit = f.supervisor.lastExit
  await f.supervisor.stop()
  expect(f.supervisor.lastExit).toEqual(exit)
})

it('主动停止和手动重启保留有意义的退出原因，超时后的 close 仍记录重启意图', async () => {
  const f = fixture()
  f.supervisor.start()
  const stopping = f.supervisor.stop()
  f.children[0]!.emit('close', 0, null)
  await stopping
  expect(f.supervisor.lastExit?.reason).toBe('batond stopped by client (code: 0, signal: none)')
  f.supervisor.start()
  const child = f.children[1]!
  vi.spyOn(child, 'kill').mockImplementation(() => true)
  const restarting = f.supervisor.restart()
  await vi.advanceTimersByTimeAsync(15_000)
  await restarting
  child.emit('close', null, 'SIGKILL')
  expect(f.supervisor.lastExit?.reason).toBe('batond stopped for restart (code: none, signal: SIGKILL)')
  const exit = f.supervisor.lastExit
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.spawn).toHaveBeenCalledTimes(3)
  expect(f.supervisor.lastExit).toEqual(exit)
  const finalStop = f.supervisor.stop()
  f.children[2]!.emit('close', 0, null)
  await finalStop
})

it('同步和异步启动失败均记录可诊断原因', async () => {
  const f = fixture(() => Date.parse('2026-06-01T12:00:00.000Z'))
  f.spawn.mockImplementationOnce(() => {
    throw new Error('offline-spawn-detail')
  })
  f.supervisor.start()
  expect(f.supervisor.lastExit).toEqual({
    at: '2026-06-01T12:00:00.000Z',
    reason: 'batond exited (code: none, signal: none); spawn_failed; 无法启动内置 batond',
  })
  await vi.advanceTimersByTimeAsync(1000)
  f.children[0]!.emit('error', new Error('offline-spawn-detail'))
  f.children[0]!.emit('close', -2, null)
  expect(f.supervisor.lastExit?.reason).toBe(
    'batond exited (code: -2, signal: none); spawn_failed; 无法启动内置 batond',
  )
  await f.supervisor.stop()
})

it('普通多行 stderr 和结构化错误的私有 message、未知 code 不进入最近退出原因', async () => {
  for (const stderr of [
    'API_KEY:\noffline-value-without-label\n',
    JSON.stringify({
      code: 'deployment_invalid',
      deployment: { private_content: 'offline-context-value' },
      message: 'offline-unlabelled-message',
    }),
    JSON.stringify({ code: 'offline-untrusted-code', message: 'offline-untrusted-message' }),
  ]) {
    const f = fixture()
    f.supervisor.start()
    f.children[0]!.stderr.emit('data', Buffer.from(stderr))
    f.children[0]!.emit('close', 78, null)
    expect(f.supervisor.lastExit?.reason).not.toContain('offline-')
    expect(f.supervisor.lastExit?.reason).toContain('code: 78, signal: none')
    expect(f.supervisor.lastExit?.reason).toContain('batond reported a failure; check logs')
    if (stderr.includes('deployment_invalid'))
      expect(f.supervisor.lastExit?.reason).toContain('Invalid connection settings')
    await f.supervisor.stop()
  }
})

it('后发停止取消仍在等待旧进程关闭的重启', async () => {
  const f = fixture()
  f.supervisor.start()
  const restarting = f.supervisor.restart()
  const stopping = f.supervisor.stop()
  f.children[0]!.emit('close', 0, null)
  await Promise.all([restarting, stopping])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.spawn).toHaveBeenCalledTimes(1)
  expect(f.supervisor.state.state).toBe('stopped')
})

it('旧停止的异步完成不会覆盖新进程的状态', async () => {
  const f = fixture()
  f.supervisor.start()
  const stopping = f.supervisor.stop()
  f.children[0]!.once('close', () => f.supervisor.start())
  f.children[0]!.emit('close', 0, null)
  await stopping
  expect(f.spawn).toHaveBeenCalledTimes(2)
  expect(f.supervisor.state.state).toBe('connecting')
  const finalStop = f.supervisor.stop()
  f.children[1]!.emit('close', 0, null)
  await finalStop
})

it.each(['close', 'timeout'])('重启等待 %s 后重新检查启动许可，不恢复已取消的运行', async (completion) => {
  const f = fixture()
  f.supervisor.start()
  let permitted = true
  const restarting = f.supervisor.restart(() => permitted)
  permitted = false
  if (completion === 'timeout') {
    vi.spyOn(f.children[0]!, 'kill').mockImplementation(() => true)
    await vi.advanceTimersByTimeAsync(15_000)
  } else f.children[0]!.emit('close', 0, null)
  await restarting
  if (completion === 'timeout') f.children[0]!.emit('close', null, 'SIGKILL')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.spawn).toHaveBeenCalledTimes(1)
  expect(f.supervisor.state.state).toBe('stopped')
})

it('已知退出原因使用固定公开说明，诊断脱敏后仍可读', async () => {
  for (const [code, reason] of [
    ['needs_reauth', 'Sign-in expired'],
    ['deployment_invalid', 'Invalid connection settings'],
  ]) {
    const f = fixture()
    f.supervisor.start()
    f.children[0]!.stderr.emit('data', Buffer.from(JSON.stringify({ code, message: 'offline-private-message' })))
    f.children[0]!.emit('close', 78, null)
    const safe = redactDiagnostics(f.supervisor.lastExit!.reason)
    expect(safe).toContain(reason)
    expect(safe).toContain('code: 78')
    expect(safe).not.toContain('offline-private-message')
    await f.supervisor.stop()
  }
})

it('只计算最近 60 秒的连续故障', () => {
  expect(restartDecision(1, {}, [1, 2, 3, 4], 100_000)).toMatchObject({ state: 'restarting', delay: 1000 })
  expect(restartDecision(1, {}, [0, 1, 2, 3], 59_999)).toMatchObject({ state: 'rejected' })
  expect(restartDecision(1, {}, [], 100_000, 10)).toMatchObject({ delay: 30_000 })
})
