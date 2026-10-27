import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Supervisor, restartDecision } from './supervisor.ts'
import { fakeProcess } from './testing/process.ts'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const children: ReturnType<typeof fakeProcess>[] = []
  const spawn = vi.fn(() => {
    const child = fakeProcess()
    children.push(child)
    return child
  })
  const changed = vi.fn()
  const supervisor = new Supervisor({ spawn, changed, log: vi.fn() })
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

it('只计算最近 60 秒的连续故障', () => {
  expect(restartDecision(1, {}, [1, 2, 3, 4], 100_000)).toMatchObject({ state: 'restarting', delay: 1000 })
  expect(restartDecision(1, {}, [0, 1, 2, 3], 59_999)).toMatchObject({ state: 'rejected' })
  expect(restartDecision(1, {}, [], 100_000, 10)).toMatchObject({ delay: 30_000 })
})
