import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpgradeSnapshot } from './batond.ts'

export type DesktopUpgradeState = NonNullable<UpgradeSnapshot['state']>
export type DesktopUpgradeStatus = UpgradeSnapshot

export interface DesktopUpdateBatond {
  upgradeStatus(): Promise<DesktopUpgradeStatus>
  prepareVersion(version: string): Promise<unknown>
  prepareSelf(packageDirectory: string): Promise<unknown>
  cancelUpgrade(): Promise<unknown>
  /** 等待迁移子进程退出，不使用普通 CLI 超时，也不在客户端退出时结束它。 */
  migrate(): Promise<unknown>
  stopThread(id: string): Promise<unknown>
}

export interface DesktopUpdateSource<Item> {
  check(): Promise<{ version: string; item?: Item; reason?: string }>
  download(item: Item): Promise<string>
  verify(item: Item, path: string): Promise<unknown>
}

export interface DesktopUpdateProblem {
  code: string
  message: string
}

export interface DesktopUpdateSnapshot<Item> {
  version: string
  active: boolean
  allowDaemon: boolean
  activity:
    | 'idle'
    | 'checking'
    | 'preparing'
    | 'waiting'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'migrating'
    | 'syncing'
    | 'error'
  status: DesktopUpgradeStatus | null
  available: { version: string; item?: Item; reason?: string } | null
  error: DesktopUpdateProblem | null
  waiting: DesktopUpdateProblem | null
}

export interface DesktopUpdateOptions<Item> {
  version: string
  userData: string
  packageDirectory: string
  batond: DesktopUpdateBatond
  supervisor: { start(): void | Promise<void>; stop(): Promise<void> }
  source: DesktopUpdateSource<Item>
  /** 成功交给平台安装入口后退出旧客户端；失败时抛错。 */
  install(path: string): Promise<unknown>
  changed(snapshot: DesktopUpdateSnapshot<Item>): void
}

const activeState = (state: DesktopUpgradeState | null | undefined) =>
  state !== undefined && state !== null && state.phase !== 'completed' && state.phase !== 'cancelled'

function problem(error: unknown): DesktopUpdateProblem {
  return {
    code:
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'desktop_update_failed',
    message: error instanceof Error ? error.message : '客户端更新失败，请检查日志后重试',
  }
}

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

/** upgrade status 是阶段的唯一依据；本地文件只记录成功运行的客户端版本。 */
export class DesktopUpdate<Item = unknown> {
  private initialized = false
  private registered = false
  private replacement = false
  private permitted = false
  private stopped = false
  private halted = false
  private lastVersion: string | undefined
  private boundOperation: string | undefined
  private installedOperation: string | undefined
  private status: DesktopUpgradeStatus | null = null
  private available: DesktopUpdateSnapshot<Item>['available'] = null
  private sourceChecked = false
  private sourceError: DesktopUpdateProblem | null = null
  private activity: DesktopUpdateSnapshot<Item>['activity'] = 'idle'
  private error: DesktopUpdateProblem | null = null
  private waiting: DesktopUpdateProblem | null = null
  private serial: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly options: DesktopUpdateOptions<Item>) {}

  get active() {
    return !this.initialized || this.replacement || activeState(this.status?.state) || (this.halted && !this.permitted)
  }

  get allowDaemon() {
    return this.permitted
  }

  get snapshot(): DesktopUpdateSnapshot<Item> {
    return {
      version: this.options.version,
      active: this.active,
      allowDaemon: this.allowDaemon,
      activity: this.activity,
      status: this.status === null ? null : structuredClone(this.status),
      available: this.available === null ? null : { ...this.available },
      error: this.error === null ? null : { ...this.error },
      waiting: this.waiting === null ? null : { ...this.waiting },
    }
  }

  /** 必须在 main 的任何普通 supervisor.start / reconcile 之前等待此方法。 */
  initialize(registered: boolean): Promise<void> {
    return this.run('initialize', async () => {
      this.registered = registered
      this.permitted = false
      this.lastVersion = await this.readVersion()
      await this.readStatus()
      this.initialized = true
      this.replacement = registered && this.lastVersion !== this.options.version
      await this.advance()
    })
  }

  /** main 在启动、每 6 小时及中心拒绝版本时调用；查询本身不发起升级。 */
  check(): Promise<void> {
    return this.run(
      'check',
      async () => {
        await this.checkSource()
        this.activity = this.halted ? 'error' : this.restingActivity()
      },
      false,
    )
  }

  /** main 的状态轮询调用；失败阶段保持暂停，直到显式 retry。 */
  refresh(): Promise<void> {
    return this.run('refresh', async () => {
      this.requireInitialized()
      await this.readStatus()
      if (!this.halted || ['syncing', 'completed', 'cancelled'].includes(this.status?.state?.phase ?? ''))
        await this.advance()
    })
  }

  startUpdate(): Promise<void> {
    return this.run('startUpdate', async () => {
      this.requireInitialized()
      if (this.halted) return
      await this.readStatus()
      if (activeState(this.status?.state)) {
        await this.advance()
        return
      }
      await this.checkSource()
      if (this.available!.version === this.options.version) return
      if (this.available!.item === undefined)
        throw failure('desktop_package_missing', this.available!.reason ?? '中心没有当前平台的客户端安装包')
      this.activity = 'preparing'
      this.emit()
      await this.options.batond.prepareVersion(this.available!.version)
      await this.readStatus()
      if (!activeState(this.status?.state) || this.status!.state!.target_version !== this.available!.version)
        throw failure('upgrade_conflict', '升级准备未保存当前中心目标，请刷新后重试')
      await this.advance()
    })
  }

  retry(): Promise<void> {
    return this.run('retry', async () => {
      this.error = null
      this.waiting = null
      this.halted = false
      if (!this.initialized) {
        this.lastVersion = await this.readVersion()
        await this.readStatus()
        this.initialized = true
        this.replacement = this.registered && this.lastVersion !== this.options.version
      } else await this.readStatus()
      await this.advance(true)
    })
  }

  cancel(): Promise<void> {
    return this.run(
      'cancel',
      async () => {
        this.requireInitialized()
        await this.readStatus()
        const state = this.status?.state
        if (!activeState(state)) return
        if (
          state!.phase === 'migrating' ||
          state!.phase === 'syncing' ||
          state!.error_code === 'upgrade_migration_failed' ||
          this.installedOperation === state!.operation_id
        )
          throw failure('upgrade_cannot_cancel', '安装交接或数据迁移已开始，不能取消升级')
        await this.options.batond.cancelUpgrade()
        await this.readStatus()
        if (activeState(this.status?.state)) throw failure('upgrade_cannot_cancel', '设备尚未确认取消升级')
        this.error = null
        this.waiting = null
        this.halted = false
        await this.recoverCancelledSource()
        if (this.replacement) await this.waitForPreviousVersion()
        else {
          this.activity = 'idle'
          await this.permitDaemon(true)
        }
      },
      false,
    )
  }

  stopWaiting(threadId: string): Promise<void> {
    return this.run(
      `stopWaiting:${threadId}`,
      async () => {
        this.requireInitialized()
        await this.readStatus()
        if (
          this.status?.state?.phase !== 'draining' ||
          !this.status.blockers.some((blocker) => blocker.kind === 'thread' && blocker.id === threadId)
        )
          throw failure('upgrade_thread_not_waiting', '该 Thread 不在本机升级等待列表中')
        await this.options.batond.stopThread(threadId)
        await this.readStatus()
        if (!this.halted) await this.advance()
      },
      false,
    )
  }

  /** 同类并发请求共用一次执行，其余请求排队；错误通过 snapshot 返回。 */
  private run(key: string, action: () => Promise<void>, haltOnError = true): Promise<void> {
    const pending = this.pending.get(key)
    if (pending) return pending
    const result = this.serial.then(async () => {
      if (this.waiting?.code === 'upgrade_busy' || this.waiting?.code === 'daemon_running') this.waiting = null
      if (!this.halted) this.error = null
      try {
        await action()
      } catch (error) {
        const issue = problem(error)
        if (issue.code === 'upgrade_busy' || issue.code === 'daemon_running') {
          this.waiting = issue
          this.activity = 'waiting'
        } else {
          this.error = issue
          this.activity = 'error'
          if (haltOnError) {
            this.halted = true
            if (!this.initialized || this.replacement || activeState(this.status?.state)) this.permitted = false
          }
        }
      }
      this.emit()
    })
    this.pending.set(key, result)
    // changed 是同步通知；即使调用方通知抛错，也不能破坏后续操作的串行链。
    this.serial = result.catch(() => {})
    void result.finally(() => this.pending.delete(key)).catch(() => {})
    return result
  }

  private emit() {
    this.options.changed(this.snapshot)
  }

  private requireInitialized() {
    if (!this.initialized) throw failure('desktop_update_not_initialized', '请先读取本机升级状态')
  }

  private async readStatus() {
    try {
      this.status = await this.options.batond.upgradeStatus()
    } catch (error) {
      this.permitted = false
      throw error
    }
    if (
      activeState(this.status.state) &&
      this.status.state!.phase !== 'draining' &&
      this.status.state!.phase !== 'syncing'
    )
      this.permitted = false
  }

  private async checkSource() {
    const previous = this.activity
    this.activity = 'checking'
    this.emit()
    this.sourceChecked = true
    try {
      this.available = await this.options.source.check()
      this.sourceError = null
    } catch (error) {
      this.sourceError = problem(error)
      throw error
    } finally {
      this.activity = previous
    }
  }

  private async confirmSelfTarget(retry: boolean): Promise<boolean> {
    if (!this.sourceChecked || retry) {
      // 未确认中心目标时保持暂停，轮询复用结果，显式重试重新查询。
      await this.checkSource().catch(() => {})
    }
    if (!this.sourceError && this.available?.version === this.options.version) return true
    this.waiting = this.sourceError
      ? { code: this.sourceError.code, message: `无法确认中心更新目标，请重试：${this.sourceError.message}` }
      : { code: 'desktop_update_required', message: `请更新到中心版本 ${this.available!.version} 后继续准备设备` }
    this.activity = 'waiting'
    await this.permitDaemon(false)
    return false
  }

  private restingActivity(): DesktopUpdateSnapshot<Item>['activity'] {
    if (this.status?.state?.phase === 'syncing') return 'syncing'
    return activeState(this.status?.state) || this.replacement ? 'waiting' : 'idle'
  }

  private async permitDaemon(permit: boolean) {
    const wasPermitted = this.permitted
    this.permitted = permit && this.registered
    this.emit()
    if (this.permitted && (!wasPermitted || this.stopped)) {
      this.stopped = false
      await this.options.supervisor.start()
    }
  }

  private async stopDaemon() {
    this.permitted = false
    this.emit()
    if (!this.stopped) {
      await this.options.supervisor.stop()
      this.stopped = true
    }
  }

  private async recoverCancelledSource() {
    const state = this.status?.state
    if (
      this.replacement &&
      state?.phase === 'cancelled' &&
      state.source_version === this.options.version &&
      state.target_version !== this.options.version
    ) {
      await this.saveVersion()
      this.replacement = false
    }
  }

  private async waitForPreviousVersion() {
    this.activity = 'waiting'
    this.waiting = {
      code: 'desktop_previous_version_required',
      message: `升级已取消，请运行${this.lastVersion === undefined ? '原版本' : ` ${this.lastVersion} 版本`}客户端继续使用原数据`,
    }
    await this.permitDaemon(false)
  }

  private async bindSelf() {
    const state = this.status?.state
    if (state && this.boundOperation === state.operation_id) return
    this.activity = 'preparing'
    this.emit()
    await this.options.batond.prepareSelf(this.options.packageDirectory)
    await this.readStatus()
    if (!activeState(this.status?.state) || this.status!.state!.target_version !== this.options.version)
      throw failure('upgrade_conflict', '当前客户端未能绑定原升级目标')
    if (state && activeState(state) && this.status!.state!.operation_id !== state.operation_id)
      throw failure('upgrade_conflict', '绑定目标时升级操作身份发生变化')
    this.boundOperation = this.status!.state!.operation_id
    this.replacement = true
  }

  private async advance(retry = false): Promise<void> {
    await this.recoverCancelledSource()
    let state = this.status?.state
    if (state?.phase === 'completed' && state.target_version === this.options.version) {
      await this.saveVersion()
      this.replacement = false
    }
    if (!activeState(state)) {
      if (this.replacement && state?.phase === 'cancelled') {
        await this.waitForPreviousVersion()
        return
      }
      if (this.replacement) {
        if (!(await this.confirmSelfTarget(retry))) return
        await this.bindSelf()
        state = this.status!.state
      } else {
        if (!this.registered) await this.saveVersion()
        this.halted = false
        this.error = null
        this.waiting = null
        this.activity = 'idle'
        await this.permitDaemon(true)
        return
      }
    }
    if (!state) throw failure('upgrade_state_invalid', '设备没有保存升级准备状态')
    const self = state.target_version === this.options.version
    if (self && state.phase !== 'syncing') {
      if (state.phase !== 'draining') await this.stopDaemon()
      await this.bindSelf()
      state = this.status!.state!
    }
    this.waiting = null
    if (state.phase === 'draining') {
      this.activity = 'waiting'
      await this.permitDaemon(!self && !this.replacement)
      return
    }
    if (state.phase === 'syncing' && self) {
      this.activity = 'syncing'
      this.halted = false
      this.error = null
      await this.permitDaemon(true)
      return
    }
    await this.stopDaemon()
    if (!self && state.phase !== 'ready')
      throw failure('upgrade_target_required', `请打开目标版本 ${state.target_version} 的客户端继续升级`)
    if (state.phase === 'failed' && !retry) {
      this.halted = true
      this.error = { code: state.error_code ?? 'upgrade_failed', message: state.reason ?? '设备升级失败，请重试' }
      this.activity = 'error'
      return
    }
    if (this.status!.blockers.length) {
      this.activity = 'waiting'
      return
    }
    if (self) {
      this.activity = 'migrating'
      this.emit()
      try {
        await this.options.batond.migrate()
      } catch (error) {
        await this.readStatus()
        throw error
      }
      await this.readStatus()
      // 子进程成功退出不等于完成；只有持久阶段允许启动 daemon。
      if (this.status?.state?.phase === 'syncing' || this.status?.state?.phase === 'completed') {
        await this.advance()
      } else if (this.status?.state?.phase === 'failed') {
        this.halted = true
        this.error = {
          code: this.status.state.error_code ?? 'upgrade_migration_failed',
          message: this.status.state.reason ?? '数据迁移失败，请重试',
        }
        this.activity = 'error'
      } else this.activity = 'waiting'
      return
    }
    if (this.installedOperation === state.operation_id) {
      this.activity = 'installing'
      return
    }
    await this.checkSource()
    if (this.available!.version !== state.target_version)
      throw failure('upgrade_target_changed', '中心版本已变化，请取消原准备后重新更新')
    const item = this.available!.item
    if (item === undefined)
      throw failure('desktop_package_missing', this.available!.reason ?? '中心没有当前平台的客户端安装包')
    this.activity = 'downloading'
    this.emit()
    const path = await this.options.source.download(item)
    this.activity = 'verifying'
    this.emit()
    await this.options.source.verify(item, path)
    // 下载期间可能有其他管理者取消操作；安装前再核对持久事实。
    await this.readStatus()
    if (this.status?.state?.operation_id !== state.operation_id || this.status.state.phase !== 'ready')
      throw failure('upgrade_conflict', '下载期间升级状态已变化，未启动安装')
    if (this.status.blockers.length) {
      this.activity = 'waiting'
      return
    }
    this.activity = 'installing'
    this.emit()
    await this.options.install(path)
    this.installedOperation = state.operation_id
  }

  private get versionFile() {
    return join(this.options.userData, 'desktop-version')
  }

  private async readVersion(): Promise<string | undefined> {
    try {
      const version = (await readFile(this.versionFile, 'utf8')).trim()
      if (!version) throw failure('desktop_version_invalid', '客户端成功版本记录为空，请检查本机数据')
      return version
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  private async saveVersion() {
    if (this.lastVersion === this.options.version) return
    await mkdir(this.options.userData, { recursive: true, mode: 0o700 })
    const temporary = `${this.versionFile}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, this.options.version + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.versionFile)
      this.lastVersion = this.options.version
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
