import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import {
  DesktopUpdate,
  type DesktopUpdateOptions,
  type DesktopUpdateSnapshot,
  type DesktopUpgradeState,
  type DesktopUpgradeStatus,
} from './update.ts'
import { fakeProcess } from './testing/process.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function state(phase: DesktopUpgradeState['phase'], target = '2'): DesktopUpgradeState {
  return { operation_id: 'original-operation', source_version: '1', target_version: target, target_path: '', phase }
}

const issue = (code: string) => Object.assign(new Error(code), { code })

async function fixture(options: { version?: string; marker?: string; state?: DesktopUpgradeState } = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'baton-update-'))
  directories.push(userData)
  const marker = join(userData, 'desktop-version')
  if (options.marker !== undefined) await writeFile(marker, options.marker + '\n')
  const version = options.version ?? '1'
  const events: string[] = []
  const snapshots: DesktopUpdateSnapshot<string>[] = []
  const queue = [{ id: 'original-input', text: 'queued before update' }]
  const sent: string[] = []
  const delivered = new Set<string>()
  const worker = fakeProcess()
  const workerKill = vi.spyOn(worker, 'kill')
  let daemon: ReturnType<typeof fakeProcess> | undefined
  const status: { -readonly [Key in keyof DesktopUpgradeStatus]: DesktopUpgradeStatus[Key] } = {
    state: options.state ?? null,
    blockers: [],
    pending_reports: 0,
  }
  const dispatchQueue = () => {
    if (daemon && (status.state?.phase === 'completed' || status.state?.phase === 'cancelled')) {
      for (const input of queue) {
        if (!delivered.has(input.id)) {
          sent.push(input.id)
          delivered.add(input.id)
        }
      }
    }
  }
  const source = {
    check: vi.fn(async () => ({ version: '2', item: 'installer-for-2' })),
    download: vi.fn(async () => {
      events.push('download')
      return join(userData, 'installer')
    }),
    verify: vi.fn(async () => {
      events.push('verify')
    }),
  }
  const batond = {
    upgradeStatus: vi.fn(async () => {
      events.push('status')
      dispatchQueue()
      return structuredClone(status)
    }),
    prepareVersion: vi.fn(async (target: string) => {
      events.push('prepare-version')
      status.state = state('draining', target)
    }),
    prepareSelf: vi.fn(async (path: string) => {
      events.push('prepare-self')
      if (!status.state || status.state.phase === 'completed' || status.state.phase === 'cancelled')
        status.state = state('draining', version)
      status.state = { ...status.state, target_path: path }
    }),
    migrate: vi.fn(async () => {
      events.push('migrate')
      status.state = { ...status.state!, phase: 'syncing' }
    }),
    cancelUpgrade: vi.fn(async () => {
      events.push('cancel')
      status.state = { ...status.state!, phase: 'cancelled' }
    }),
    stopThread: vi.fn(async (_id: string) => {
      events.push('stop-thread')
    }),
    resume: vi.fn(async () => {
      queue.splice(0)
    }),
  }
  const supervisor = {
    start: vi.fn(() => {
      if (!daemon) {
        events.push('start')
        daemon = fakeProcess()
      }
      // 替身保留原队列身份；中心完成回执或取消后才派发。
      dispatchQueue()
    }),
    stop: vi.fn(async () => {
      events.push('stop')
      daemon?.stdin.end()
      daemon?.emit('close', 0)
      daemon = undefined
    }),
  }
  const install = vi.fn(async (_path: string) => {
    events.push('install')
  })
  const controllerOptions: DesktopUpdateOptions<string> = {
    version,
    userData,
    packageDirectory: '/application/resources/batond',
    batond,
    source,
    supervisor,
    install,
    changed: (snapshot) => snapshots.push(snapshot),
  }
  const create = () => new DesktopUpdate(controllerOptions)
  return {
    update: create(),
    create,
    status,
    marker,
    source,
    batond,
    supervisor,
    install,
    snapshots,
    events,
    worker,
    workerKill,
    queue,
    sent,
  }
}

it('初始化前禁止普通监管，先读持久升级状态；未注册客户端只保存成功版本', async () => {
  const f = await fixture()
  expect(f.update.allowDaemon).toBe(false)
  expect(f.update.active).toBe(true)
  await f.update.initialize(false)
  expect(f.events).toEqual(['status'])
  expect(f.update.allowDaemon).toBe(false)
  expect(f.update.active).toBe(false)
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()

  const registered = f.create()
  await registered.initialize(true)
  expect(registered.allowDaemon).toBe(true)
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  await f.update.initialize(true)
  expect(f.update.allowDaemon).toBe(true)
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.events.indexOf('status')).toBeLessThan(f.events.indexOf('start'))
})

it('无设备身份时更新旧成功标记，后续新注册无需迁移', async () => {
  const f = await fixture({ version: '2', marker: '1' })
  await f.update.initialize(false)
  expect(await readFile(f.marker, 'utf8')).toBe('2\n')
  await f.update.initialize(true)
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.update.allowDaemon).toBe(true)
})

it.each([undefined, '0'])('缺少当前成功版本且中心已升级时先等待中心目标，不迁移旧客户端（标记 %s）', async (marker) => {
  const f = await fixture(marker === undefined ? {} : { marker })
  f.batond.prepareSelf.mockImplementation(async (path) => {
    f.status.state = { ...state('ready', '1'), target_path: path }
  })
  f.batond.prepareVersion.mockImplementationOnce(async (target) => {
    f.status.state = state('ready', target)
  })
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({
    active: true,
    allowDaemon: false,
    activity: 'waiting',
    status: { state: null },
    available: { version: '2' },
  })
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.supervisor.start).not.toHaveBeenCalled()
  await f.update.refresh()
  await f.update.refresh()
  expect(f.source.check).toHaveBeenCalledTimes(1)
  await f.update.startUpdate()
  expect(f.batond.prepareVersion).toHaveBeenCalledWith('2')
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(f.update.snapshot.activity).toBe('installing')
})

it('首次自动准备前中心不可达时保持等待，轮询使用缓存，重试查询后可以安装中心目标', async () => {
  const f = await fixture()
  f.source.check.mockRejectedValueOnce(issue('center_unreachable'))
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({
    allowDaemon: false,
    activity: 'waiting',
    status: { state: null },
    waiting: { code: 'center_unreachable' },
  })
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  await f.update.refresh()
  await f.update.refresh()
  expect(f.source.check).toHaveBeenCalledTimes(1)
  await f.update.retry()
  expect(f.source.check).toHaveBeenCalledTimes(2)
  expect(f.update.snapshot).toMatchObject({ allowDaemon: false, available: { version: '2' }, error: null })
  f.batond.prepareVersion.mockImplementationOnce(async (target) => {
    f.status.state = state('ready', target)
  })
  await f.update.startUpdate()
  expect(f.batond.prepareVersion).toHaveBeenCalledWith('2')
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.install).toHaveBeenCalledTimes(1)
})

it('确认中心当前版本后才允许自动 self；中心不可达的重试可以继续原首次准备', async () => {
  const f = await fixture()
  f.source.check.mockRejectedValueOnce(issue('center_unreachable'))
  await f.update.initialize(true)
  f.source.check.mockResolvedValue({ version: '1', item: 'installer-for-1' })
  f.batond.prepareSelf.mockImplementationOnce(async (path) => {
    f.status.state = { ...state('ready', '1'), target_path: path }
  })
  await f.update.retry()
  expect(f.source.check).toHaveBeenCalledTimes(2)
  expect(f.batond.prepareSelf).toHaveBeenCalledTimes(1)
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  expect(f.update.snapshot).toMatchObject({ activity: 'syncing', allowDaemon: true, error: null, waiting: null })
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('已有 syncing 状态时中心换版也不重写目标，不发起其他升级或绕过完成回执', async () => {
  const f = await fixture({ version: '1', state: state('syncing', '1') })
  await f.update.initialize(true)
  expect(f.source.check).not.toHaveBeenCalled()
  await f.update.check()
  await f.update.startUpdate()
  expect(f.status.state).toMatchObject({ phase: 'syncing', target_version: '1', operation_id: 'original-operation' })
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.prepareVersion).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.install).not.toHaveBeenCalled()
  expect(f.sent).toEqual([])
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([undefined, '1'])('直接替换且成功标记为 %s 时，Worker 阻挡准备；完成回执后原队列只发送一次', async (marker) => {
  const f = await fixture({ version: '2', ...(marker === undefined ? {} : { marker }) })
  f.status.blockers = [{ kind: 'thread', id: 'local-thread', pid: 400, reason: 'worker_alive' }]
  f.status.pending_reports = 3
  await f.update.initialize(true)
  expect(f.batond.prepareSelf).toHaveBeenCalledWith('/application/resources/batond')
  expect(f.update.snapshot).toMatchObject({
    active: true,
    allowDaemon: false,
    activity: 'waiting',
    status: { state: { phase: 'draining' }, blockers: [{ id: 'local-thread', pid: 400 }], pending_reports: 3 },
  })
  expect(f.supervisor.start).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.workerKill).not.toHaveBeenCalled()
  expect(f.sent).toEqual([])
  const originalOperation = f.status.state!.operation_id

  f.worker.emit('close', 0)
  f.status.blockers = []
  f.status.state = { ...f.status.state!, phase: 'ready' }
  await f.update.refresh()
  expect(f.update.snapshot).toMatchObject({ allowDaemon: true, activity: 'syncing', active: true })
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  expect(f.events.indexOf('stop')).toBeLessThan(f.events.indexOf('migrate'))
  expect(f.events.indexOf('migrate')).toBeLessThan(f.events.indexOf('start'))
  expect(f.sent).toEqual([])
  expect(f.status.state!.operation_id).toBe(originalOperation)
  if (marker === undefined) await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(f.marker, 'utf8')).toBe(marker + '\n')

  f.status.state = { ...f.status.state!, phase: 'completed' }
  await f.update.refresh()
  await f.update.refresh()
  await f.update.retry()
  expect(await readFile(f.marker, 'utf8')).toBe('2\n')
  expect(f.update.snapshot).toMatchObject({ active: false, allowDaemon: true, activity: 'idle' })
  expect(f.queue).toEqual([{ id: 'original-input', text: 'queued before update' }])
  expect(f.sent).toEqual(['original-input'])
  expect(f.batond.resume).not.toHaveBeenCalled()
})

it('按中心最新目标 prepareVersion；只允许停止本机 thread blocker，取消保留原队列', async () => {
  const f = await fixture({ marker: '1' })
  await f.update.initialize(true)
  f.sent.splice(0)
  await f.update.check()
  f.source.check.mockResolvedValue({ version: '3', item: 'installer-for-3' })
  await f.update.startUpdate()
  expect(f.batond.prepareVersion).toHaveBeenCalledWith('3')
  expect(f.update.snapshot.status?.state).toMatchObject({ phase: 'draining', target_version: '3' })
  expect(f.update.allowDaemon).toBe(true)
  expect(f.supervisor.stop).not.toHaveBeenCalled()

  f.status.blockers = [
    { kind: 'thread', id: 'local-a', reason: 'worker_alive' },
    { kind: 'thread', id: 'local-b', reason: 'worker_alive' },
    { kind: 'runtime', id: 'runtime', reason: 'runtime_alive' },
  ]
  await f.update.stopWaiting('remote-thread')
  await f.update.stopWaiting('runtime')
  expect(f.batond.stopThread).not.toHaveBeenCalled()
  await Promise.all([f.update.stopWaiting('local-a'), f.update.stopWaiting('local-b')])
  expect(f.batond.stopThread.mock.calls.map(([id]) => id)).toEqual(['local-a', 'local-b'])
  await f.update.cancel()
  expect(f.update.snapshot).toMatchObject({ active: false, allowDaemon: true, activity: 'idle', error: null })
  expect(f.status.state!.phase).toBe('cancelled')
  expect(f.queue.map((input) => input.id)).toEqual(['original-input'])
  expect(f.batond.resume).not.toHaveBeenCalled()
  expect(f.install).not.toHaveBeenCalled()
})

it.each(['download', 'verify', 'install'] as const)('%s 失败保留 ready，显式重试再次校验且不重复安装', async (step) => {
  const f = await fixture({ marker: '1', state: state('draining') })
  await f.update.initialize(true)
  const error = issue(`${step}_failed`)
  if (step === 'install') f.install.mockRejectedValueOnce(error)
  else f.source[step].mockRejectedValueOnce(error)
  f.status.state = state('ready')
  await f.update.refresh()
  expect(f.status.state).toEqual(state('ready'))
  expect(f.update.snapshot).toMatchObject({ allowDaemon: false, activity: 'error', error: { code: `${step}_failed` } })
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
  expect(f.batond.migrate).not.toHaveBeenCalled()
  const attempts = f.source.download.mock.calls.length
  await f.update.refresh()
  expect(f.source.download).toHaveBeenCalledTimes(attempts)
  await f.update.retry()
  expect(f.events.indexOf('stop')).toBeLessThan(f.events.indexOf('download'))
  expect(f.events.lastIndexOf('verify')).toBeLessThan(f.events.lastIndexOf('install'))
  expect(f.update.snapshot).toMatchObject({ allowDaemon: false, activity: 'installing', error: null })
  const installed = f.install.mock.calls.length
  await Promise.all([f.update.refresh(), f.update.retry(), f.update.startUpdate()])
  expect(f.install).toHaveBeenCalledTimes(installed)
  expect(f.source.verify).toHaveBeenCalledTimes(step === 'download' ? 1 : 2)
})

it.each([undefined, '1'])('直接替换取消后保留 cancelled，轮询和重启都要求运行原客户端（标记 %s）', async (marker) => {
  const f = await fixture({ version: '2', ...(marker === undefined ? {} : { marker }) })
  f.status.blockers = [{ kind: 'thread', id: 'worker', reason: 'worker_alive' }]
  await f.update.initialize(true)
  await f.update.cancel()
  expect(f.update.snapshot).toMatchObject({
    active: true,
    allowDaemon: false,
    activity: 'waiting',
    waiting: { code: 'desktop_previous_version_required' },
    status: { state: { phase: 'cancelled' } },
  })
  expect(f.update.snapshot.waiting?.message).toContain('请运行')
  await f.update.refresh()
  await f.update.check()
  await f.update.retry()
  const restarted = f.create()
  await restarted.initialize(true)
  expect(f.batond.prepareSelf).toHaveBeenCalledTimes(1)
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.supervisor.start).not.toHaveBeenCalled()
  expect(restarted.snapshot.waiting?.code).toBe('desktop_previous_version_required')
  expect(f.workerKill).not.toHaveBeenCalled()
})

it('无版本标记的原客户端取消自己的中心版本更新后恢复，重启依据原source_version继续', async () => {
  const f = await fixture()
  await f.update.initialize(true)
  expect(f.update.allowDaemon).toBe(false)
  await f.update.startUpdate()
  expect(f.status.state).toMatchObject({ source_version: '1', target_version: '2', phase: 'draining' })
  await f.update.cancel()
  expect(f.update.allowDaemon).toBe(true)
  expect(f.supervisor.start).toHaveBeenCalledOnce()
  expect(f.sent).toEqual(['original-input'])
  await rm(f.marker)
  const restarted = f.create()
  await restarted.initialize(true)
  await restarted.refresh()
  expect(restarted.allowDaemon).toBe(true)
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
  expect(f.batond.prepareSelf).not.toHaveBeenCalled()
  expect(f.batond.migrate).not.toHaveBeenCalled()
  expect(f.sent).toEqual(['original-input'])
})

it('取消占锁的 waiting 在取消成功后清除', async () => {
  const f = await fixture({ marker: '1', state: state('draining') })
  await f.update.initialize(true)
  f.batond.cancelUpgrade.mockRejectedValueOnce(issue('upgrade_busy'))
  await f.update.cancel()
  expect(f.update.snapshot.waiting?.code).toBe('upgrade_busy')
  await f.update.cancel()
  expect(f.update.snapshot).toMatchObject({
    active: false,
    allowDaemon: true,
    activity: 'idle',
    waiting: null,
    error: null,
  })
})

it('当前版本与 target 相同且已有成功标记时仍绑定原 ready 操作', async () => {
  const f = await fixture({ version: '2', marker: '2', state: state('ready') })
  await f.update.initialize(true)
  expect(f.batond.prepareSelf).toHaveBeenCalledTimes(1)
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  expect(f.status.state!.operation_id).toBe('original-operation')
  expect(f.update.snapshot.activity).toBe('syncing')
})

it('下载中断后重启从原 ready 操作继续，校验安装包后才交给平台', async () => {
  const f = await fixture({ marker: '1', state: state('ready') })
  f.source.download.mockRejectedValueOnce(issue('download_interrupted'))
  await f.update.initialize(true)
  expect(f.update.snapshot.activity).toBe('error')
  const restarted = f.create()
  await restarted.initialize(true)
  expect(f.status.state!.operation_id).toBe('original-operation')
  expect(f.batond.prepareVersion).not.toHaveBeenCalled()
  expect(f.source.download).toHaveBeenCalledTimes(2)
  expect(f.source.verify).toHaveBeenCalledTimes(1)
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(restarted.allowDaemon).toBe(false)
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
})

it.each(['ready', 'migrating', 'syncing', 'completed', 'failed'] as const)(
  '目标客户端从 %s 阶段恢复',
  async (phase) => {
    const f = await fixture({ version: '2', marker: '1', state: state(phase) })
    await f.update.initialize(true)
    expect(f.source.download).not.toHaveBeenCalled()
    expect(f.install).not.toHaveBeenCalled()
    expect(f.batond.prepareVersion).not.toHaveBeenCalled()
    expect(f.batond.migrate).toHaveBeenCalledTimes(phase === 'ready' || phase === 'migrating' ? 1 : 0)
    expect(f.update.allowDaemon).toBe(phase !== 'failed')
    expect(await readFile(f.marker, 'utf8')).toBe(phase === 'completed' ? '2\n' : '1\n')
    if (phase === 'ready') {
      expect(f.batond.prepareSelf).toHaveBeenCalledTimes(1)
      expect(f.status.state!.operation_id).toBe('original-operation')
    }
    if (phase === 'failed') {
      await f.update.retry()
      expect(f.update.snapshot.activity).toBe('syncing')
      expect(f.batond.migrate).toHaveBeenCalledTimes(1)
    }
  },
)

it('迁移失败读取原 failed 状态，保持暂停；重试同一操作后仅在 syncing 启动 daemon', async () => {
  const f = await fixture({ version: '2', marker: '1', state: state('ready') })
  f.batond.migrate.mockImplementationOnce(async () => {
    f.status.state = {
      ...f.status.state!,
      phase: 'failed',
      error_code: 'upgrade_migration_failed',
      reason: 'ledger failed',
    }
    throw issue('upgrade_migration_failed')
  })
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({
    allowDaemon: false,
    activity: 'error',
    status: { state: { phase: 'failed', reason: 'ledger failed' } },
  })
  expect(f.supervisor.start).not.toHaveBeenCalled()
  await f.update.refresh()
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  await f.update.cancel()
  expect(f.batond.cancelUpgrade).not.toHaveBeenCalled()
  await f.update.retry()
  expect(f.update.allowDaemon).toBe(true)
  expect(f.status.state).toMatchObject({ operation_id: 'original-operation', phase: 'syncing' })
  expect(f.batond.migrate).toHaveBeenCalledTimes(2)
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
})

it('长时迁移与轮询、重试串行，不重复启动迁移；迁移开始后不能取消', async () => {
  const f = await fixture({ version: '2', marker: '1', state: state('ready') })
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  f.batond.migrate.mockImplementationOnce(async () => {
    f.status.state = { ...f.status.state!, phase: 'migrating' }
    entered.resolve()
    await finish.promise
    f.status.state = { ...f.status.state!, phase: 'syncing' }
  })
  const initialized = f.update.initialize(true)
  await entered.promise
  expect(f.update.snapshot).toMatchObject({ activity: 'migrating', allowDaemon: false })
  const refresh = f.update.refresh()
  const retry = f.update.retry()
  const cancel = f.update.cancel()
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  expect(f.supervisor.start).not.toHaveBeenCalled()
  finish.resolve()
  await Promise.all([initialized, refresh, retry, cancel])
  expect(f.batond.migrate).toHaveBeenCalledTimes(1)
  expect(f.update.allowDaemon).toBe(true)
  expect(f.batond.cancelUpgrade).not.toHaveBeenCalled()
})

it('外部迁移占锁时显示等待，不能把 busy 当迁移完成', async () => {
  const f = await fixture({ version: '2', marker: '1', state: state('migrating') })
  f.batond.migrate.mockRejectedValueOnce(issue('upgrade_busy'))
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({
    activity: 'waiting',
    allowDaemon: false,
    error: null,
    waiting: { code: 'upgrade_busy' },
  })
  expect(f.supervisor.start).not.toHaveBeenCalled()
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
  await f.update.refresh()
  expect(f.update.snapshot).toMatchObject({ activity: 'syncing', allowDaemon: true, waiting: null })
})

it('迁移命令成功返回但持久阶段仍未 syncing 时不启动 daemon', async () => {
  const f = await fixture({ version: '2', marker: '1', state: state('ready') })
  f.batond.migrate.mockResolvedValueOnce(undefined)
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({ activity: 'waiting', allowDaemon: false })
  expect(f.supervisor.start).not.toHaveBeenCalled()
  expect(await readFile(f.marker, 'utf8')).toBe('1\n')
})

it('轮询只在监管许可变化时请求启动，不绕过 supervisor 的终止拒绝与退避', async () => {
  const f = await fixture({ marker: '1' })
  await f.update.initialize(true)
  await f.update.refresh()
  await f.update.refresh()
  await f.update.check()
  expect(f.supervisor.start).toHaveBeenCalledTimes(1)

  const upgrading = await fixture({ marker: '1', state: state('draining') })
  await upgrading.update.initialize(true)
  await upgrading.update.refresh()
  await upgrading.update.refresh()
  expect(upgrading.supervisor.start).toHaveBeenCalledTimes(1)
})

it('读取状态失败时禁止监管，retry 重读后才能恢复', async () => {
  const f = await fixture({ marker: '1' })
  f.batond.upgradeStatus.mockRejectedValueOnce(issue('upgrade_state_invalid'))
  await f.update.initialize(true)
  expect(f.update.snapshot).toMatchObject({
    allowDaemon: false,
    activity: 'error',
    error: { code: 'upgrade_state_invalid' },
  })
  expect(f.supervisor.start).not.toHaveBeenCalled()
  await f.update.retry()
  expect(f.update.snapshot).toMatchObject({ allowDaemon: true, active: false, error: null })
})

it('下载期间外部取消或中心目标变化时不安装，也不改写原操作目标', async () => {
  const f = await fixture({ marker: '1', state: state('ready') })
  f.source.check.mockResolvedValueOnce({ version: '3', item: 'installer-for-3' })
  await f.update.initialize(true)
  expect(f.update.snapshot.error?.code).toBe('upgrade_target_changed')
  expect(f.source.download).not.toHaveBeenCalled()
  expect(f.status.state).toEqual(state('ready'))
  f.source.download.mockImplementationOnce(async () => {
    f.status.state = state('cancelled')
    return '/verified-installer'
  })
  await f.update.retry()
  expect(f.source.verify).toHaveBeenCalledTimes(1)
  expect(f.install).not.toHaveBeenCalled()
  expect(f.update.snapshot.error?.code).toBe('upgrade_conflict')
})

it('安装成功交接前一直阻止 reconcile，重复更新操作共用一次安装', async () => {
  const f = await fixture({ marker: '1', state: state('ready') })
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  f.install.mockImplementationOnce(async () => {
    expect(f.update.allowDaemon).toBe(false)
    entered.resolve()
    await finish.promise
  })
  const first = f.update.initialize(true)
  await entered.promise
  const requests = [f.update.refresh(), f.update.refresh(), f.update.retry(), f.update.startUpdate()]
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(f.update.allowDaemon).toBe(false)
  finish.resolve()
  await Promise.all([first, ...requests])
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(f.update.allowDaemon).toBe(false)
})
