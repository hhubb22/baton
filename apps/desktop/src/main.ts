import { app, dialog, ipcMain, session, shell, type BrowserWindow } from 'electron'
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
      void serialize(async () => {
        await reconcile(true)
      }).catch(reportError)
    },
    logs: () => {
      void shell.openPath(join(dataDirectory, 'logs')).catch(reportError)
    },
    quit: () => app.quit(),
    loginEnabled: () => login.enabled(),
    setLogin: (enabled) => {
      void login.set(enabled).then(refresh).catch(reportError)
    },
  })
  async function refresh() {
    try {
      const daemon = await readDaemonStatus(dataDirectory)
      const previousCode = status.code
      status = mergeStatus(identity, supervisor.state, daemon)
      tray.update(status)
      if (window && !window.isDestroyed()) window.webContents.send('baton:status-changed', status)
      if (status.code === 'node_version_incompatible' && previousCode !== status.code && configuration && window) {
        void window.loadURL(`${configuration.coordinator_url}/devices`).catch(() => {})
        show()
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
      await reconcile()
    }).catch(reportError)
  }
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin
  await replaceWindow(hidden)
  await reconcile()
  for (const link of pendingLinks.splice(0)) receiveLink(link)
  const poll = setInterval(() => {
    void refresh()
  }, 1000)
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    clearInterval(poll)
    void (async () => {
      await serial
      await supervisor.stop()
      await log.flush()
      tray.destroy()
      app.quit()
    })().catch(() => app.exit(1))
  })
}
