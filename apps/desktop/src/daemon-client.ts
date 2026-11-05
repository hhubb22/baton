import { join } from 'node:path'
import { Schema } from 'effect'
import { ControlClient } from '@baton/batond/daemon/control-client'
import type { ControlRequest } from '@baton/batond/daemon/control'
import { ThreadDirectory } from './local.ts'
import { desktopStatus, stoppedStatus, type DesktopStatus, type StartLoginResult } from './status.ts'

export class LocalActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function deviceExecutable(resources: string) {
  return join(resources, 'batond', process.platform === 'win32' ? 'batond.exe' : 'batond')
}

export class DaemonClient {
  readonly control: ControlClient
  constructor(resources: string, dataDirectory: string, control?: ControlClient) {
    this.control =
      control ?? new ControlClient(dataDirectory, { command: { executable: deviceExecutable(resources), args: [] } })
  }

  async status(autostart = true): Promise<DesktopStatus> {
    try {
      return desktopStatus(await this.control.request({ method: 'status' }, { autostart }))
    } catch {
      return stoppedStatus()
    }
  }

  private async request(request: ControlRequest, options: { autostart?: boolean; timeoutMs?: number } = {}) {
    const response = await this.control.request(request, options)
    if (!response.ok)
      throw new LocalActionError(response.code ?? 'local_action_failed', response.message ?? '本机操作失败。')
    return response
  }

  async startLogin(coordinatorUrl: string, displayName?: string): Promise<StartLoginResult> {
    const response = await this.request({
      method: 'login_start',
      coordinator_url: coordinatorUrl,
      ...(displayName ? { display_name: displayName } : {}),
    })
    if (response.status === 'already_bound') return { status: 'already_bound', device: await this.status(false) }
    if (
      response.status === 'pending' &&
      response.session_id !== undefined &&
      response.user_code !== undefined &&
      response.verification_uri !== undefined &&
      response.verification_uri_complete !== undefined &&
      response.expires_at !== undefined &&
      response.expires_in_seconds !== undefined
    )
      return {
        status: 'pending',
        login: {
          session_id: response.session_id,
          user_code: response.user_code,
          verification_uri: response.verification_uri,
          verification_uri_complete: response.verification_uri_complete,
          expires_at: response.expires_at,
          expires_in_seconds: response.expires_in_seconds,
        },
      }
    throw new LocalActionError('login_unavailable', '本机未能开始设备登录，请重试。')
  }

  async cancelLogin(): Promise<void> {
    await this.request({ method: 'login_cancel' })
  }

  async logout(): Promise<void> {
    await this.request({ method: 'logout' })
  }

  async threadDirectory(threadId: string): Promise<ThreadDirectory> {
    const response = await this.request({ method: 'resolve_thread_directory', thread_id: threadId })
    if (response.directory === undefined) throw new LocalActionError('directory_missing', '此对话的文件夹不可用。')
    try {
      return Schema.decodeUnknownSync(ThreadDirectory)({
        node_id: response.node_id,
        employee_id: response.employee_id,
        coordinator_url: response.coordinator_url,
        working_directory: response.directory,
      })
    } catch {
      throw new LocalActionError('directory_unavailable', '此对话的文件夹不可用。')
    }
  }

  async restart(): Promise<void> {
    await this.control.request({ method: 'shutdown' }, { autostart: false, timeoutMs: 10_000 }).catch(() => {})
    await this.status()
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    await this.control.request({ method: 'shutdown' }, { autostart: false, timeoutMs })
  }
}

// 用户服务托管时客户端退出不停止守护进程；内置按需守护进程随客户端退出。
export function quitAction(serviceInstalled: boolean | undefined): 'shutdown' | 'keep' {
  return serviceInstalled === true ? 'keep' : 'shutdown'
}

export async function stopDaemonForQuit(
  control: Pick<ControlClient, 'request'>,
  status: DesktopStatus | undefined,
  timeoutMs = 10_000,
): Promise<'shutdown' | 'keep'> {
  const action = quitAction(status?.service_installed)
  if (action === 'keep') return action
  await control.request({ method: 'shutdown' }, { autostart: false, timeoutMs }).catch(() => {})
  return action
}
