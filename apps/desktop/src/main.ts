import { app, dialog, ipcMain, Menu, session, shell, type BrowserWindow } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { Batond, daemonLog } from './batond.ts'
import { authorizeBridge, assertIdentityOrigin, EnrollmentInput } from './bridge.ts'
import { loadDeployment, saveDeployment, parseConnectLink, caFingerprint, type DeploymentConfig } from './deployment.ts'
import { verifyCertificate } from './trust.ts'
import { createWindow } from './window.ts'
import { Supervisor } from './supervisor.ts'
import { mergeStatus, readDaemonStatus, type PublicIdentity } from './status.ts'
import { createTray } from './tray.ts'
import { autostart } from './autostart.ts'
import { DesktopUpdate } from './update.ts'
import { UpdateDownloader } from './update-download.ts'
import { launchNSIS } from './update-install.ts'
import { updatePresentation } from './update-ui.ts'
import type { DownloadItem } from '@baton/protocol/http-api'

app.setName('Baton')

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
  const dataDirectory = join(homedir(), '.baton-ts')
  await mkdir(join(dataDirectory, 'logs'), { recursive: true, mode: 0o700 })
  const batond = new Batond(process.resourcesPath, dataDirectory)
  const version = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    JSON.parse(await readFile(join(process.resourcesPath, 'batond', 'release.json'), 'utf8')),
  ).version
  const log = daemonLog(dataDirectory, () => {
    supervisor.reject('log_failed', '无法写入 batond 日志，请检查数据目录权限')
  })
  let status = mergeStatus(identity, { state: 'stopped' })
  let updater: DesktopUpdate<DownloadItem> | undefined
  let updateDialog = false
  let lastUpdateError = ''
  const show = () => {
    window?.show()
    window?.focus()
  }
  const reportError = (error: unknown) =>
    dialog.showErrorBox('Baton', error instanceof Error ? error.message : '操作失败')
  const supervisor = new Supervisor({
    spawn: () => batond.run(),
    log: (chunk) => log.write(chunk),
    changed: () => {
      void refresh()
    },
  })
  const login = await autostart(userData)
  const tray = createTray({
    open: show,
    restart: () => {
      if (!updater?.allowDaemon) {
        void showUpdate().catch(reportError)
        return
      }
      void serialize(async () => {
        await reconcile(true)
      }).catch(reportError)
    },
    update: () => {
      void showUpdate().catch(reportError)
    },
    updateLabel: () => (updater ? updatePresentation(updater.snapshot).label : '检查客户端更新'),
    logs: () => {
      void shell.openPath(join(dataDirectory, 'logs')).catch(reportError)
    },
    quit: () => app.quit(),
    loginEnabled: () => login.enabled(),
    setLogin: (enabled) => {
      void login.set(enabled).then(refresh).catch(reportError)
    },
  })
  const downloader = new UpdateDownloader()
  updater = new DesktopUpdate<DownloadItem>({
    version,
    userData,
    packageDirectory: join(process.resourcesPath, 'batond'),
    batond,
    supervisor: {
      start: () => {
        if (!quitting && configuration && identity.registered) supervisor.start()
      },
      stop: () => supervisor.stop(),
    },
    source: {
      check: async () => {
        if (!configuration) throw new Error('请先保存中心地址')
        const result = await downloader.check(configuration, version)
        return {
          version: result.release.version,
          ...(result.status === 'available' ? { item: result.item } : {}),
          ...(result.status === 'unavailable' ? { reason: result.reason } : {}),
        }
      },
      download: (item) => {
        if (!configuration) throw new Error('请先保存中心地址')
        return downloader.download(configuration, item, userData)
      },
      verify: (item, path) => downloader.verify(item, path),
    },
    install: async (path) => {
      if (quitting) throw new Error('客户端正在退出，请重新启动后继续更新')
      if (process.platform === 'win32') await launchNSIS(path)
      else if (process.platform === 'darwin') {
        const error = await shell.openPath(path)
        if (error) throw new Error(`无法打开安装包：${error}`)
        await dialog.showMessageBox({
          type: 'info',
          title: '替换 Baton 客户端',
          message: '把新版本 Baton 拖入「应用程序」并替换旧版',
          detail: '设备已暂停升级。关闭此提示后旧版会退出；替换完成后打开新版，设备数据会自动迁移。',
          buttons: ['退出并替换'],
          noLink: true,
        })
      } else throw new Error('当前平台不支持桌面客户端更新')
      app.quit()
    },
    changed: (snapshot) => {
      const error = snapshot.error ? `${snapshot.error.code}：${snapshot.error.message}` : ''
      if (error && error !== lastUpdateError) log.write(Buffer.from(`${new Date().toISOString()} ${error}\n`))
      lastUpdateError = error
      if (!quitting) void refresh()
    },
  })
  async function showUpdate(check = false) {
    if (!updater || updateDialog || quitting) return
    updateDialog = true
    try {
      show()
      if (check) await updater.check()
      const snapshot = updater.snapshot
      const presentation = updatePresentation(snapshot)
      const buttons: string[] = ['关闭']
      const operations: Array<() => Promise<unknown>> = [async () => {}]
      const add = (label: string, operation: () => Promise<unknown>) => {
        buttons.push(label)
        operations.push(operation)
      }
      if (
        (!snapshot.status?.state || ['completed', 'cancelled'].includes(snapshot.status.state.phase)) &&
        snapshot.available?.version !== version &&
        snapshot.available?.item
      )
        add(`更新到 ${snapshot.available.version}`, () => updater!.startUpdate())
      if (snapshot.error || snapshot.waiting) add('重试', () => updater!.retry())
      else if (!snapshot.active && !snapshot.available?.item) add('检查更新', () => updater!.check())
      const state = snapshot.status?.state
      if (state && ['draining', 'ready'].includes(state.phase)) add('取消更新', () => updater!.cancel())
      const threads = snapshot.status?.blockers.filter((item) => item.kind === 'thread') ?? []
      if (state?.phase === 'draining' && threads.length > 0)
        add('停止等待中的工作', async () => {
          const selected = await dialog.showMessageBox({
            type: 'warning',
            title: '停止工作',
            message: '选择要停止的工作',
            detail: '停止会沿用原有停止规则，撤回该工作尚未发送的输入。',
            buttons: ['返回', ...threads.map((item) => item.id)],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          if (selected.response > 0) await updater!.stopWaiting(threads[selected.response - 1]!.id)
        })
      add('打开日志目录', () => shell.openPath(join(dataDirectory, 'logs')))
      const result = await dialog.showMessageBox({
        type: snapshot.error ? 'warning' : 'info',
        title: 'Baton 客户端更新',
        message: presentation.label,
        detail: `${status.code === 'node_version_incompatible' ? `${status.message ?? status.code}\n` : ''}${presentation.detail}`,
        buttons,
        defaultId: buttons.length > 1 ? 1 : 0,
        cancelId: 0,
        noLink: true,
      })
      // 操作可能打开安装提示；先关闭当前进度对话框。
      updateDialog = false
      await operations[result.response]?.()
    } finally {
      updateDialog = false
    }
  }
  function updateWindowMenu() {
    const label = updater ? updatePresentation(updater.snapshot).label : '检查客户端更新'
    if (window && !window.isDestroyed()) window.setTitle(`Baton · ${label}`)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        {
          label: 'Baton',
          submenu: [
            {
              label,
              click: () => {
                void showUpdate(true).catch(reportError)
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
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    )
  }
  async function refresh() {
    try {
      const daemon = await readDaemonStatus(dataDirectory)
      const previousCode = status.code
      status = mergeStatus(identity, supervisor.state, daemon)
      tray.update(status)
      updateWindowMenu()
      if (window && !window.isDestroyed()) window.webContents.send('baton:status-changed', status)
      if (status.code === 'node_version_incompatible' && previousCode !== status.code && configuration) {
        void showUpdate(true).catch(reportError)
      }
    } catch {
      status = {
        ...identity,
        state: 'rejected',
        code: 'status_unavailable',
        message: '无法读取本机设备状态，请检查日志',
      }
      tray.update(status)
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
    if (!updater?.allowDaemon) {
      await refresh()
      return
    }
    if (restart) await supervisor.restart()
    else supervisor.start()
    await refresh()
  }
  async function replaceWindow(hidden = false) {
    window?.destroy()
    window = createWindow(__dirname, configuration?.coordinator_url, version, () => quitting)
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
  ipcMain.handle('baton:update', async (event) => {
    authorize(event)
    await showUpdate(true)
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
        if (running && running.pid !== supervisor.state.pid) throw new Error('请先停止外部 batond 服务，再重新认证')
        await supervisor.stop()
        await saveDeployment(userData, configuration)
        identity =
          action === 'enroll'
            ? await batond.enroll(configuration, userData, parsed.code, parsed.displayName ?? hostname())
            : await batond.reauth(configuration, userData, parsed.code)
        await updater!.initialize(identity.registered)
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
      await updater!.initialize(identity.registered)
      await updater!.check()
      await reconcile()
    }).catch(reportError)
  }
  let poll: ReturnType<typeof setInterval> | undefined
  let updatePoll: ReturnType<typeof setInterval> | undefined
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    clearInterval(poll)
    clearInterval(updatePoll)
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
  await updater.initialize(identity.registered)
  if (quitting) return
  if (configuration) await updater.check()
  await reconcile()
  if (quitting) return
  for (const link of pendingLinks.splice(0)) receiveLink(link)
  poll = setInterval(() => {
    if (!quitting) void updater!.refresh().then(refresh).catch(reportError)
  }, 1000)
  updatePoll = setInterval(
    () => {
      if (!quitting && configuration) void updater!.check().catch(reportError)
    },
    6 * 60 * 60 * 1000,
  )
}
