import { app, clipboard, dialog, ipcMain, Menu, session, shell, Notification, type BrowserWindow } from 'electron'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { Batond } from './batond.ts'
import {
  authorizeBridge,
  LoginInput,
  NotificationBatch,
  NotificationScope,
  TrayActivity,
  ViewingThread,
} from './bridge.ts'
import {
  linkDecision,
  loadCoordinator,
  parseConnectLink,
  saveCoordinator,
  type CoordinatorConfig,
} from './coordinator.ts'
import { createWindow } from './window.ts'
import { DaemonClient, stopDaemonForQuit } from './daemon-client.ts'
import { type DesktopStatus } from './status.ts'
import { createTray } from './tray.ts'
import { autostart } from './autostart.ts'
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

let configuration: CoordinatorConfig | undefined
let status: DesktopStatus = { state: 'stopped', registered: false }
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
  const requestedDataDirectory = join(homedir(), '.baton', 'data')
  await mkdir(join(requestedDataDirectory, 'logs'), { recursive: true, mode: 0o700 })
  const dataDirectory = await realpath(requestedDataDirectory)
  const batond = new Batond(process.resourcesPath, dataDirectory)
  await batond.bootstrap()
  const daemon = new DaemonClient(process.resourcesPath, dataDirectory)
  const release = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String, commit: Schema.String }))(
    JSON.parse(await readFile(join(process.resourcesPath, 'batond', 'release.json'), 'utf8')),
  )
  const version = release.version
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
    restartAvailable: () => status.service_installed !== true,
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
  function updateWindowMenu() {
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
  let coordinatorMismatch = ''
  async function refresh() {
    const previous = status.rejection?.code
    status = await daemon.status()
    tray.update(status, activity, systemNotificationsDisabled)
    updateWindowMenu()
    if (status.registered && status.node_id && status.rejection) {
      const rejection = status.rejection
      const key = `device:${status.node_id}:${rejection.code}:${rejection.at}`
      await notices.deliver(
        notificationScope('local-device'),
        [
          {
            event_id: key,
            title: status.display_name ?? 'Baton',
            body: `连接被拒绝：${rejection.message}`,
            node_id: status.node_id,
          },
        ],
        null,
        null,
      )
    }
    if (window && !window.isDestroyed()) window.webContents.send('baton:status-changed', status)
    if (status.rejection?.code === 'node_version_incompatible' && previous !== status.rejection.code && configuration) {
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'Baton 需要更新',
          message: '本机节点与中心协议不兼容',
          detail: `${status.rejection.message}\n请下载与中心匹配的安装包，停止本机守护进程后覆盖安装并重新启动。`,
          buttons: ['知道了'],
          noLink: true,
        })
        .catch(reportError)
    }
    return status
  }
  async function reconcile(restart = false) {
    if (quitting) return
    if (!configuration) {
      await refresh()
      return
    }
    if (restart) await daemon.restart()
    const current = await refresh()
    if (
      current.registered &&
      current.coordinator_url !== undefined &&
      current.coordinator_url !== configuration.coordinator_url &&
      coordinatorMismatch !== current.coordinator_url
    ) {
      coordinatorMismatch = current.coordinator_url
      void dialog.showMessageBox({
        type: 'error',
        title: '中心地址不一致',
        message: `本机已接入 ${current.coordinator_url}`,
        detail: `已保存的中心地址是 ${configuration.coordinator_url}。请先在终端运行 batond logout，或从原中心重新接入。`,
        buttons: ['知道了'],
        noLink: true,
      })
    }
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
    const saved = await refresh()
    if (!configuration || !saved.registered || !saved.employee_id || !saved.coordinator_url)
      throw new Error('请先连接此电脑。')
    if (saved.coordinator_url !== configuration.coordinator_url) throw new Error('本机设备属于其他中心。')
    const current = Schema.decodeUnknownSync(Schema.Struct({ employee: Schema.Struct({ id: Schema.String }) }))(
      await centerJSON('/api/v1/me'),
    )
    return localAccount(saved, configuration.coordinator_url, current.employee.id)
  }
  async function localDiagnostics(): Promise<DesktopDiagnostics> {
    const current = await refresh()
    return {
      clientVersion: version,
      batondVersion: current.batond_version ?? 'unknown',
      platform: current.platform ?? `${process.platform} ${process.arch}`,
      processState: current.state,
      lastExit: current.last_error
        ? { at: current.last_error.at, reason: redactDiagnostics(current.last_error.message) }
        : null,
      canRestart: current.service_installed !== true && !quitting,
    }
  }
  const localActions = new LocalActions({
    identity: localIdentity,
    setModelConnectionKey: (connectionId, key) => batond.setModelConnectionKey(connectionId, key),
    threadNode: async (threadId) =>
      Schema.decodeUnknownSync(Schema.Struct({ node_id: Schema.String }))(
        await centerJSON(`/api/v1/threads/${encodeURIComponent(threadId)}`),
      ).node_id,
    directory: (threadId) => daemon.threadDirectory(threadId),
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
      const summary = diagnosticSummary(
        await localDiagnostics(),
        await readLogTail(join(dataDirectory, 'logs', 'batond.log')),
      )
      await clipboard.writeText(summary)
    },
  })
  registerLocalBridge<Electron.IpcMainInvokeEvent>(
    (channel, callback) => ipcMain.handle(channel, callback),
    authorize,
    localActions,
  )
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
  ipcMain.handle('baton:start-login', (event, input: unknown) => {
    authorize(event)
    const parsed = (() => {
      try {
        return Schema.decodeUnknownSync(LoginInput)(input ?? {}, { onExcessProperty: 'error' })
      } catch {
        throw new Error('设备名称无效')
      }
    })()
    return serialize(async () => {
      authorize(event)
      if (!configuration) throw new Error('请先打开中心的接入链接')
      const result = await daemon.startLogin(configuration.coordinator_url, parsed.displayName ?? hostname())
      await refresh()
      return result
    })
  })
  ipcMain.handle('baton:cancel-login', (event) =>
    serialize(async () => {
      authorize(event)
      await daemon.cancelLogin()
      await refresh()
    }),
  )
  ipcMain.handle('baton:logout', (event) =>
    serialize(async () => {
      authorize(event)
      await daemon.logout()
      return refresh()
    }),
  )
  try {
    configuration = await loadCoordinator(userData)
  } catch {
    dialog.showErrorBox('中心配置无效', '请从中心重新打开接入链接，原配置未修改')
  }
  app.setAsDefaultProtocolClient('baton')
  receiveLink = (raw) => {
    void serialize(async () => {
      let candidate: string
      try {
        candidate = parseConnectLink(raw)
      } catch {
        throw new Error('接入链接无效，请从中心重新打开')
      }
      const current = await daemon.status()
      const decision = linkDecision(
        configuration?.coordinator_url,
        current.registered ? current.coordinator_url : undefined,
        candidate,
      )
      if (decision === 'conflict') {
        await dialog.showMessageBox({
          type: 'error',
          title: '无法更换中心',
          message: `本机已接入 ${current.coordinator_url}`,
          detail: '请先在终端运行 batond logout，再接入新的中心。现有身份和配置未修改。',
          buttons: ['知道了'],
          noLink: true,
        })
        return
      }
      show()
      const confirmation = await dialog.showMessageBox({
        type: 'question',
        title: '连接 Baton 中心',
        message: candidate,
        detail:
          decision === 'replace'
            ? '本机尚未连接中心，确认后将替换已保存的中心地址。\n确认这是中心的 HTTPS 地址后继续。'
            : '确认这是中心的 HTTPS 地址后继续。',
        buttons: ['取消', '连接'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) return
      await saveCoordinator(userData, candidate)
      configuration = { format: 1, coordinator_url: candidate }
      await replaceWindow()
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
      const current = await daemon.status(false)
      await stopDaemonForQuit(daemon.control, current)
      tray.destroy()
      app.quit()
    })().catch(() => app.exit(1))
  })
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin
  await replaceWindow(hidden)
  await reconcile()
  if (quitting) return
  for (const link of pendingLinks.splice(0)) receiveLink(link)
  poll = setInterval(() => {
    if (!quitting)
      void serialize(async () => {
        await refresh()
      }).catch(reportError)
  }, 1000)
  void checkNotificationPermissions()
  permissionPoll = setInterval(() => {
    if (!quitting) void checkNotificationPermissions()
  }, 30_000)
}
