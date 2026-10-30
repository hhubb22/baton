import { app, clipboard, dialog, ipcMain, Menu, session, shell, Notification, type BrowserWindow } from 'electron'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { Batond, daemonLog } from './batond.ts'
import {
  authorizeBridge,
  assertIdentityOrigin,
  EnrollmentInput,
  NotificationBatch,
  NotificationScope,
  TrayActivity,
  ViewingThread,
} from './bridge.ts'
import { loadDeployment, saveDeployment, parseConnectLink, caFingerprint, type DeploymentConfig } from './deployment.ts'
import { verifyCertificate } from './trust.ts'
import { createWindow } from './window.ts'
import { isUpdateStartupFailure, Supervisor } from './supervisor.ts'
import { managedDaemonPid, mergeStatus, readDaemonStatus, readDaemonRejection, type PublicIdentity } from './status.ts'
import { createTray } from './tray.ts'
import { autostart } from './autostart.ts'
import { prepareDesktopInstaller } from './update-feed.ts'
import { desktopArtifact, shouldHandoffDesktop } from './update-handoff.ts'
import { compareUpdateVersions } from '@baton/batond/daemon/update-version'
import {
  notificationState,
  notificationPresenter,
  emptyActivity,
  type NotificationTarget,
  type Activity,
} from './notifications.ts'
import { notificationsDisabled, notificationSettingsURL } from './notification-permission.ts'
import { LocalActions, localAccount, registerLocalBridge } from './local.ts'
import { diagnosticSummary, readLogTail, redactDiagnostics, type DesktopDiagnostics } from './diagnostics.ts'
import { editorPreferences, launchEditor } from './editor.ts'

app.setName('Baton')
if (process.platform === 'win32') app.setAppUserModelId('dev.baton.desktop')

let configuration: DeploymentConfig | undefined
let identity: PublicIdentity = { registered: false }
let window: BrowserWindow | undefined
let quitting = false
let serial: Promise<unknown> = Promise.resolve()
function serialize<A>(task: () => Promise<A>): Promise<A> {
  const next = serial.then(task)
  serial = next.catch(() => {})
  return next
}
const pendingLinks = process.argv.filter((argument) => argument.startsWith('baton:'))
let receiveLink = (link: string) => {
  pendingLinks.push(link)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receiveLink(url)
  })
  app.on('second-instance', (_event, argv) => {
    for (const link of argv.filter((argument) => argument.startsWith('baton:'))) receiveLink(link)
    window?.show()
    window?.focus()
  })
  app.on('window-all-closed', () => {})
  app.on('activate', () => {
    window?.show()
    window?.focus()
  })
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox('Baton 无法启动', error instanceof Error ? error.message : '请重新安装客户端')
      quitting = true
      app.quit()
    })
}

async function start() {
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true, mode: 0o700 })
  const requestedDataDirectory = join(homedir(), '.baton-ts')
  await mkdir(join(requestedDataDirectory, 'logs'), { recursive: true, mode: 0o700 })
  const dataDirectory = await realpath(requestedDataDirectory)
  const batond = new Batond(process.resourcesPath, dataDirectory)
  await batond.bootstrap()
  const release = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String, commit: Schema.String }))(
    JSON.parse(await readFile(join(process.resourcesPath, 'batond', 'release.json'), 'utf8')),
  )
  const version = release.version
  const log = daemonLog(dataDirectory, () => {
    supervisor.reject('log_failed', '无法写入 batond 日志，请检查数据目录权限')
  })
  let status = mergeStatus(identity, { state: 'stopped' })
  const show = () => {
    window?.show()
    window?.focus()
  }
  const reportError = (error: unknown) =>
    dialog.showErrorBox('Baton', error instanceof Error ? error.message : '操作失败')
  let activity: Activity = emptyActivity
  let viewingThread: string | null = null
  let pendingTarget: NotificationTarget | undefined
  let targetReady = false
  let systemNotificationsDisabled: boolean | null = null
  const openTarget = (target: NotificationTarget) => {
    pendingTarget = target
    show()
    if (targetReady && window && configuration) {
      try {
        authorizeBridge(window.webContents.getURL(), configuration.coordinator_url, true)
        window.webContents.send('baton:open-target', target)
        pendingTarget = undefined
      } catch {
        /* 等中心页面完成加载后再导航。 */
      }
    } else if (window && configuration) {
      void window.loadURL(configuration.coordinator_url).catch(reportError)
    }
  }
  const notices = await notificationState(
    userData,
    notificationPresenter((notice) => {
      if (!Notification.isSupported() || systemNotificationsDisabled === true) return null
      const notification = new Notification({ title: notice.title, body: notice.body })
      notification.on('show', () =>
        console.info(JSON.stringify({ event: 'desktop.notification_shown', event_id: notice.event_id })),
      )
      notification.on('failed', () =>
        console.warn(JSON.stringify({ event: 'desktop.notification_failed', event_id: notice.event_id })),
      )
      return notification
    }, openTarget),
  )
  const notificationScope = (scope: string) => JSON.stringify([configuration?.coordinator_url, scope])
  let lastManagedPid: number | undefined
  let managedStartedAt = 0
  let startingUpdate: { operationId: string; attempt: number } | undefined
  let startupFailureBlocked = false
  const supervisor = new Supervisor({
    spawn: () => {
      startingUpdate =
        deviceUpdate?.phase === 'syncing'
          ? { operationId: deviceUpdate.operation_id, attempt: deviceUpdate.attempt }
          : undefined
      return batond.run()
    },
    log: (chunk) => log.write(chunk),
    unexpectedExit: (info) => {
      const operation = startingUpdate
      if (!operation || !isUpdateStartupFailure(info)) return
      startupFailureBlocked = true
      void serialize(async () => {
        await supervisor.stop()
        await batond.reportUpdateStartupFailure(operation.operationId, operation.attempt)
        await refreshDeviceUpdate()
        await refresh()
      }).catch(reportError)
    },
    changed: (state) => {
      if (state.pid) {
        lastManagedPid = undefined
        managedStartedAt = Date.now()
      }
      void refresh()
    },
  })
  const login = await autostart(userData)
  const editor = await editorPreferences(userData)
  async function showSettings() {
    const selected = await dialog.showMessageBox({
      title: 'Baton 设置',
      message: '编辑器',
      detail: editor.get() ?? '系统默认',
      buttons: ['关闭', '选择编辑器', '使用系统默认', '通知设置'],
      cancelId: 0,
      noLink: true,
    })
    if (selected.response === 1) {
      const choice = await dialog.showOpenDialog({
        title: '选择编辑器',
        properties: ['openFile'],
        filters: [{ name: '应用程序', extensions: [process.platform === 'darwin' ? 'app' : 'exe'] }],
      })
      if (!choice.canceled && choice.filePaths[0]) await editor.set(choice.filePaths[0])
    } else if (selected.response === 2) await editor.set(null)
    else if (selected.response === 3) await shell.openExternal(notificationSettingsURL())
  }
  const tray = createTray({
    open: show,
    restart: () => {
      void serialize(async () => {
        await reconcile(true)
      }).catch(reportError)
    },
    restartAvailable: () => !startupFailureBlocked && !deviceUpdateError && !blocksDaemon(deviceUpdate),
    update: () => {
      void showUpdate().catch(reportError)
    },
    updateLabel: () => '更新并重启',
    logs: () => {
      void shell.openPath(join(dataDirectory, 'logs')).catch(reportError)
    },
    quit: () => app.quit(),
    notificationsEnabled: () => notices.enabled(),
    setNotifications: (enabled) => {
      void notices.setEnabled(enabled).then(refresh).catch(reportError)
    },
    notificationSettings: () => {
      void shell.openExternal(notificationSettingsURL()).catch(reportError)
    },
    settings: () => {
      void showSettings().catch(reportError)
    },
    openThread: (thread_id) => openTarget({ thread_id }),
    loginEnabled: () => login.enabled(),
    setLogin: (enabled) => {
      void login.set(enabled).then(refresh).catch(reportError)
    },
  })
  let deviceUpdate: Awaited<ReturnType<Batond['updateStatus']>> = null
  let deviceUpdateError = ''
  let updateBusy = false
  let handoffError = ''
  let handoffAttempt = ''
  const blocksDaemon = (state: typeof deviceUpdate) =>
    !!state &&
    (state.phase === 'ready' || state.phase === 'migrating' || (state.phase === 'failed' && !state.rollback_complete))
  const updatePhases: Record<string, string> = {
    draining: '等待工作结束',
    ready: '准备就绪',
    migrating: '正在迁移',
    syncing: '正在同步',
    completed: '更新完成',
    cancelled: '已取消',
    failed: '更新失败',
  }

  async function refreshDeviceUpdate() {
    try {
      deviceUpdate = await batond.updateStatus()
      deviceUpdateError = ''
      if (deviceUpdate?.phase === 'failed' && deviceUpdate.rollback_complete) startupFailureBlocked = false
    } catch (error) {
      deviceUpdateError = error instanceof Error ? error.message : '无法读取设备更新状态'
    }
    return deviceUpdate
  }

  async function continueUpdate() {
    if (deviceUpdateError || !deviceUpdate) return
    if (['ready', 'migrating'].includes(deviceUpdate.phase)) {
      await supervisor.stop()
      return
    }
    if (!shouldHandoffDesktop(deviceUpdate)) return
    if (deviceUpdate.target_version) {
      const key = `${deviceUpdate.operation_id}:${deviceUpdate.attempt}`
      if (handoffAttempt === key) {
        if (!handoffError && deviceUpdate.target_version === version && deviceUpdate.phase === 'syncing')
          await reconcile()
        return
      }
      handoffAttempt = key
      try {
        if (deviceUpdate.target_version === version) {
          const manifest = await batond.updateManifest()
          desktopArtifact(manifest, deviceUpdate.target_version)
          if (manifest.payload.commit !== release.commit) throw new Error('相同版本的桌面构建与签名清单不一致')
          if (deviceUpdate.phase === 'syncing') await reconcile()
        } else await handoffDesktop()
      } catch (error) {
        handoffError = error instanceof Error ? error.message : '桌面更新失败，请重试。'
      }
      return
    }
  }

  async function handoffDesktop() {
    if (!configuration || !deviceUpdate?.target_version) throw new Error('无法确认更新目标')
    const selected = deviceUpdate
    const manifest = await batond.updateManifest()
    desktopArtifact(manifest, selected.target_version!)
    if (
      version !== 'development' &&
      (compareUpdateVersions(manifest.payload.version, version) < 0 ||
        (manifest.payload.version === version && manifest.payload.commit !== release.commit))
    )
      throw new Error('更新目标早于或不同于当前桌面版本')
    const downloaded = await batond.downloadDesktopFeed(selected.operation_id, selected.attempt)
    const installer = await prepareDesktopInstaller({ manifest, dataDirectory, downloaded })
    const current = await batond.updateStatus()
    if (
      current?.operation_id !== selected.operation_id ||
      current.attempt !== selected.attempt ||
      current.target_version !== selected.target_version ||
      !['syncing', 'completed'].includes(current.phase)
    ) {
      installer.close()
      throw new Error('更新目标已变化，请重新检查')
    }
    await supervisor.stop()
    await log.flush()
    clearInterval(poll)
    clearInterval(permissionPoll)
    tray.destroy()
    quitting = true
    installer.install()
  }

  async function showUpdate() {
    if (updateBusy || quitting) return
    updateBusy = true
    try {
      await refreshDeviceUpdate()
      const detail = deviceUpdate
        ? `${deviceUpdate.phase === 'syncing' && deviceUpdate.target_version !== version ? '等待安装桌面应用' : (updatePhases[deviceUpdate.phase] ?? deviceUpdate.phase)} · ${deviceUpdate.target_version ?? ''}\n${deviceUpdate.reason ?? ''}`
        : deviceUpdateError || '尚无更新操作'
      const result = await dialog.showMessageBox({
        title: 'Baton 更新',
        message: '更新并重启 Baton',
        detail: `${detail}\n当前版本：${version}${handoffError ? `\n${handoffError}` : ''}${process.platform === 'win32' ? '\nWindows 可能显示安全警告；未签名安装包的系统发布者身份未经认证。' : '\nmacOS 自动安装需要经过 Developer ID 签名和公证的发布包。'}`,
        buttons: [
          '关闭',
          handoffError ? '重试' : '更新并重启',
          '更新设置',
          ...(deviceUpdate && ['draining', 'ready'].includes(deviceUpdate.phase) ? ['取消更新'] : []),
        ],
        cancelId: 0,
        noLink: true,
      })
      if (result.response === 1) {
        if (handoffError && deviceUpdate && ['syncing', 'completed'].includes(deviceUpdate.phase)) {
          handoffError = ''
          handoffAttempt = ''
        } else {
          const manifest = await batond.updateManifest()
          desktopArtifact(manifest, manifest.payload.version)
          if (
            version !== 'development' &&
            (compareUpdateVersions(manifest.payload.version, version) < 0 ||
              (manifest.payload.version === version && manifest.payload.commit !== release.commit))
          )
            throw new Error('签名更新目标早于或不同于当前桌面版本')
          await batond.update()
          startupFailureBlocked = false
          await refreshDeviceUpdate()
          await refresh()
        }
      } else if (result.response === 2) {
        const policy = await batond.updatePolicy()
        const choice = await dialog.showMessageBox({
          title: '更新设置',
          message: '选择安装更新的方式',
          detail: policy === 'idle' ? '当前：空闲时自动更新' : '当前：手动更新',
          buttons: ['取消', '手动更新', '空闲时自动更新'],
          cancelId: 0,
          noLink: true,
        })
        if (choice.response === 1) await batond.updatePolicy('manual')
        else if (choice.response === 2) await batond.updatePolicy('idle')
      } else if (result.response === 3) {
        await batond.cancelUpdate()
        await refreshDeviceUpdate()
        await reconcile()
      }
    } finally {
      updateBusy = false
    }
  }
  function updateWindowMenu() {
    const label = '更新并重启'
    if (window && !window.isDestroyed()) window.setTitle(`Baton · ${label}`)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [
              {
                label: 'Baton',
                submenu: [
                  { role: 'about' as const, label: '关于 Baton' },
                  { type: 'separator' as const },
                  { role: 'services' as const, label: '服务' },
                  { type: 'separator' as const },
                  { role: 'hide' as const, label: '隐藏 Baton' },
                  { role: 'hideOthers' as const, label: '隐藏其他应用' },
                  { role: 'unhide' as const, label: '显示所有应用' },
                  { type: 'separator' as const },
                  { role: 'quit' as const, label: '退出 Baton' },
                ],
              },
            ]
          : []),
        {
          label: 'Baton',
          submenu: [
            {
              label,
              click: () => {
                void showUpdate().catch(reportError)
              },
            },
            {
              label: '设置…',
              click: () => {
                void showSettings().catch(reportError)
              },
            },
            {
              label: '打开日志目录',
              click: () => {
                void shell.openPath(join(dataDirectory, 'logs')).catch(reportError)
              },
            },
          ],
        },
        {
          label: '编辑',
          submenu: [
            { role: 'undo', label: '撤销' },
            { role: 'redo', label: '重做' },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' },
          ],
        },
        {
          label: '显示',
          submenu: [
            { role: 'reload', label: '重新加载' },
            { role: 'forceReload', label: '强制重新加载' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            { role: 'resetZoom', label: '实际大小' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '切换全屏' },
          ],
        },
        {
          label: '窗口',
          submenu: [
            { role: 'minimize', label: '最小化' },
            { role: 'zoom', label: '缩放' },
            { role: 'close', label: '关闭窗口' },
          ],
        },
      ]),
    )
  }
  async function refresh() {
    try {
      const daemon = await readDaemonStatus(dataDirectory)
      const ownedPid = await managedDaemonPid(dataDirectory, supervisor.state.pid)
      if (ownedPid !== undefined) lastManagedPid = ownedPid
      const previousCode = status.code
      const supervisorStatus = { ...supervisor.state }
      delete supervisorStatus.pid
      if (ownedPid !== undefined) supervisorStatus.pid = ownedPid
      status = mergeStatus(identity, supervisorStatus, daemon)
      tray.update(status, activity, systemNotificationsDisabled)
      updateWindowMenu()
      const rejection =
        daemon?.state === 'rejected'
          ? daemon
          : await readDaemonRejection(dataDirectory, lastManagedPid, managedStartedAt)
      if (identity.registered && rejection) {
        const key = `device:${identity.node_id}:${rejection.code}:${rejection.updated_at}`
        await notices.deliver(
          notificationScope('local-device'),
          [
            {
              event_id: key,
              title: identity.display_name,
              body: `连接被拒绝：${rejection.message ?? rejection.code}`,
              node_id: identity.node_id,
            },
          ],
          null,
          null,
        )
      }
      if (window && !window.isDestroyed()) window.webContents.send('baton:status-changed', status)
      if (status.code === 'node_version_incompatible' && previousCode !== status.code && configuration) {
        void showUpdate().catch(reportError)
      }
    } catch {
      status = {
        ...identity,
        state: 'rejected',
        code: 'status_unavailable',
        message: '无法读取本机设备状态，请检查日志',
      }
      tray.update(status, activity, systemNotificationsDisabled)
    }
    return status
  }
  async function reconcile(restart = false) {
    if (quitting) return
    identity = await batond.identity()
    if (!configuration || !identity.registered) {
      await refresh()
      return
    }
    try {
      assertIdentityOrigin(identity, configuration.coordinator_url)
    } catch (error) {
      supervisor.reject('coordinator_conflict', error instanceof Error ? error.message : '中心地址冲突')
      await refresh()
      return
    }
    if (startupFailureBlocked || deviceUpdateError || blocksDaemon(deviceUpdate)) {
      await refresh()
      return
    }
    if (restart) await supervisor.restart(() => !quitting && !blocksDaemon(deviceUpdate))
    else supervisor.start()
    await refresh()
  }
  async function replaceWindow(hidden = false) {
    window?.destroy()
    window = createWindow(__dirname, configuration?.coordinator_url, version, () => quitting)
    targetReady = false
    viewingThread = null
    activity = emptyActivity
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        targetReady = false
        viewingThread = null
      }
    })
    window.webContents.on('render-process-gone', () => {
      viewingThread = null
      activity = emptyActivity
    })
    if (configuration) await window.loadURL(configuration.coordinator_url).catch(() => {})
    else await window.loadFile(join(__dirname, 'setup.html'))
    if (!hidden) show()
  }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(verifyCertificate(request.hostname, request.certificate, configuration))
  })
  function authorize(event: Electron.IpcMainInvokeEvent) {
    authorizeBridge(
      event.senderFrame?.url ?? '',
      configuration?.coordinator_url,
      event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame,
    )
  }
  async function centerJSON(path: string) {
    if (!configuration) throw new Error('请先连接此电脑。')
    const response = await session.defaultSession.fetch(`${configuration.coordinator_url}${path}`, {
      credentials: 'include',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('Sign in to this computer’s account to use local actions.')
    return response.json() as Promise<unknown>
  }
  async function localIdentity() {
    const saved = await batond.identity()
    if (!configuration || !saved.registered || !saved.employee_id) throw new Error('请先连接此电脑。')
    assertIdentityOrigin(saved, configuration.coordinator_url)
    const current = Schema.decodeUnknownSync(Schema.Struct({ employee: Schema.Struct({ id: Schema.String }) }))(
      await centerJSON('/api/v1/me'),
    )
    return localAccount(saved, configuration.coordinator_url, current.employee.id)
  }
  async function localDiagnostics(): Promise<DesktopDiagnostics> {
    await refresh()
    const daemon = await readDaemonStatus(dataDirectory)
    const ownedPid = await managedDaemonPid(dataDirectory, supervisor.state.pid)
    const external = status.state === 'external'
    return {
      clientVersion: version,
      batondVersion: daemon?.batond_version ?? 'unknown',
      platform: `${process.platform} ${process.arch}`,
      processState: external ? 'external' : status.state,
      lastExit: supervisor.lastExit
        ? { ...supervisor.lastExit, reason: redactDiagnostics(supervisor.lastExit.reason) }
        : null,
      upgradePhase: deviceUpdate?.phase ?? null,
      canRestart:
        !external &&
        !startupFailureBlocked &&
        !deviceUpdateError &&
        (!daemon || daemon.pid === ownedPid) &&
        !blocksDaemon(deviceUpdate) &&
        !quitting,
    }
  }
  const localActions = new LocalActions({
    identity: localIdentity,
    setModelConnectionKey: (connectionId, key) => batond.setModelConnectionKey(connectionId, key),
    threadNode: async (threadId) =>
      Schema.decodeUnknownSync(Schema.Struct({ node_id: Schema.String }))(
        await centerJSON(`/api/v1/threads/${encodeURIComponent(threadId)}`),
      ).node_id,
    directory: (threadId) => batond.directory(threadId),
    openDirectory: async (path, useEditor) => {
      const selected = editor.get()
      if (useEditor && selected) await launchEditor(selected, path)
      else {
        const error = await shell.openPath(path)
        if (error) throw new Error('无法打开此文件夹。')
      }
    },
    pickDirectory: async () => {
      const selected = await dialog.showOpenDialog({ title: '选择本地文件夹', properties: ['openDirectory'] })
      return selected.canceled ? null : (selected.filePaths[0] ?? null)
    },
    diagnostics: localDiagnostics,
    restart: () =>
      serialize(async () => {
        if (!(await localDiagnostics()).canRestart) throw new Error('当前无法重启设备服务。')
        await reconcile(true)
      }),
    openLogs: async () => {
      const error = await shell.openPath(join(dataDirectory, 'logs'))
      if (error) throw new Error('无法打开日志文件夹。')
    },
    copyDiagnostics: async () => {
      await log.flush()
      const summary = diagnosticSummary(
        await localDiagnostics(),
        await readLogTail(join(dataDirectory, 'logs', 'desktop-batond.log')),
      )
      await clipboard.writeText(summary)
    },
  })
  registerLocalBridge<Electron.IpcMainInvokeEvent>(
    (channel, callback) => ipcMain.handle(channel, callback),
    authorize,
    localActions,
  )
  ipcMain.handle('baton:update', async (event) => {
    authorize(event)
    await showUpdate()
  })
  ipcMain.handle('baton:notification-cursor', (event, input: unknown) => {
    authorize(event)
    return notices.cursor(notificationScope(Schema.decodeUnknownSync(NotificationScope)(input)))
  })
  ipcMain.handle('baton:notifications', (event, input: unknown) => {
    authorize(event)
    const batch = Schema.decodeUnknownSync(NotificationBatch)(input)
    // 本机拒绝只从 daemon 的持久状态通知，涵盖登录前和连接被中心断开的情况。
    const events = batch.events.filter((notice) => notice.kind !== 'device_rejected')
    return notices.deliver(notificationScope(batch.scope), events, batch.cursor, () =>
      window?.isVisible() && window.isFocused() ? viewingThread : null,
    )
  })
  ipcMain.handle('baton:activity', (event, input: unknown) => {
    authorize(event)
    activity = Schema.decodeUnknownSync(TrayActivity)(input)
    tray.update(status, activity, systemNotificationsDisabled)
  })
  ipcMain.handle('baton:viewing-thread', (event, input: unknown) => {
    authorize(event)
    viewingThread = Schema.decodeUnknownSync(ViewingThread)(input)
  })
  ipcMain.handle('baton:target-unready', (event) => {
    authorize(event)
    targetReady = false
  })
  ipcMain.handle('baton:target-ready', (event) => {
    authorize(event)
    targetReady = true
    if (pendingTarget) openTarget(pendingTarget)
  })
  ipcMain.handle('baton:status', async (event) => {
    authorize(event)
    return refresh()
  })
  for (const action of ['enroll', 'reauth'] as const)
    ipcMain.handle(`baton:${action}`, (event, input: unknown) => {
      authorize(event)
      const parsed = (() => {
        try {
          return Schema.decodeUnknownSync(EnrollmentInput)(input)
        } catch {
          throw new Error('接入参数无效，请重新领取接入凭据')
        }
      })()
      return serialize(async () => {
        authorize(event)
        if (!configuration) throw new Error('请先打开中心的接入链接')
        identity = await batond.identity()
        assertIdentityOrigin(identity, configuration.coordinator_url)
        if (action === 'enroll' && identity.registered) throw new Error('本机已接入，请使用已有身份或重新认证')
        if (action === 'reauth' && !identity.registered) throw new Error('本机尚未接入')
        const running = await readDaemonStatus(dataDirectory)
        if (running && running.pid !== (await managedDaemonPid(dataDirectory, supervisor.state.pid)))
          throw new Error('请先停止外部 batond 服务，再重新认证')
        await supervisor.stop()
        await saveDeployment(userData, configuration)
        identity =
          action === 'enroll'
            ? await batond.enroll(configuration, userData, parsed.code, parsed.displayName ?? hostname())
            : await batond.reauth(configuration, userData, parsed.code)
        await refreshDeviceUpdate()
        await reconcile(true)
        return refresh()
      })
    })
  try {
    configuration = await loadDeployment(userData)
    if (configuration) await saveDeployment(userData, configuration)
  } catch {
    dialog.showErrorBox('部署配置无效', '请从中心重新打开接入链接，原配置未修改')
  }
  app.setAsDefaultProtocolClient('baton')
  receiveLink = (raw) => {
    void serialize(async () => {
      let candidate: DeploymentConfig
      try {
        candidate = parseConnectLink(raw)
      } catch {
        throw new Error('接入链接无效，请从中心重新打开')
      }
      const currentIdentity = await batond.identity()
      assertIdentityOrigin(currentIdentity, candidate.coordinator_url)
      show()
      const confirmation = await dialog.showMessageBox({
        type: 'question',
        title: '连接 Baton 中心',
        message: candidate.coordinator_url,
        detail: `CA SHA-256：${caFingerprint(candidate)}\n确认地址与中心提供的指纹一致后继续。`,
        buttons: ['取消', '连接'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) return
      await saveDeployment(userData, candidate)
      configuration = candidate
      await replaceWindow()
      identity = currentIdentity
      await refreshDeviceUpdate()
      await reconcile()
    }).catch(reportError)
  }
  let poll: ReturnType<typeof setInterval> | undefined
  let permissionPoll: ReturnType<typeof setInterval> | undefined
  const checkNotificationPermissions = async () => {
    systemNotificationsDisabled = await notificationsDisabled()
    tray.update(status, activity, systemNotificationsDisabled)
  }
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    clearInterval(poll)
    clearInterval(permissionPoll)
    void (async () => {
      await serial
      await supervisor.stop()
      await log.flush()
      tray.destroy()
      app.quit()
    })().catch(() => app.exit(1))
  })
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin
  await replaceWindow(hidden)
  identity = await batond.identity()
  if (configuration) assertIdentityOrigin(identity, configuration.coordinator_url)
  const initialUpdate = await refreshDeviceUpdate()
  if (quitting) return
  await continueUpdate()
  if (!initialUpdate || !['syncing', 'ready', 'migrating'].includes(initialUpdate.phase)) await reconcile()
  if (quitting) return
  for (const link of pendingLinks.splice(0)) receiveLink(link)
  poll = setInterval(() => {
    if (!quitting)
      void serialize(async () => {
        await refreshDeviceUpdate()
        await continueUpdate()
        await refresh()
      }).catch(reportError)
  }, 1000)
  void checkNotificationPermissions()
  permissionPoll = setInterval(() => {
    if (!quitting) void checkNotificationPermissions()
  }, 30_000)
}
