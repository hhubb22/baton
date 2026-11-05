import type { ControlResponse, PendingLogin } from '@baton/batond/daemon/control'

export type DesktopState = NonNullable<ControlResponse['state']> | 'stopped'

export interface LoginStart {
  session_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_at: string
  expires_in_seconds: number
}

export type StartLoginResult =
  | { status: 'pending'; login: LoginStart }
  | { status: 'already_bound'; device: DesktopStatus }

export interface DesktopStatus {
  state: DesktopState
  registered: boolean
  pid?: number
  batond_version?: string
  protocol_version?: number
  platform?: string
  coordinator_url?: string
  node_id?: string
  employee_id?: string
  display_name?: string
  rejection?: { code: string; message: string; at: string }
  pending_login?: PendingLogin
  last_error?: { code: string; message: string; at: string }
  service_installed?: boolean
}

// 控制通道返回的是设备公开状态；桌面不读取账本或凭据文件。
export function desktopStatus(response: ControlResponse): DesktopStatus {
  const state = response.state ?? 'unbound'
  return {
    state,
    registered: response.node_id !== undefined,
    ...(response.pid !== undefined ? { pid: response.pid } : {}),
    ...(response.batond_version !== undefined ? { batond_version: response.batond_version } : {}),
    ...(response.protocol_version !== undefined ? { protocol_version: response.protocol_version } : {}),
    ...(response.platform !== undefined ? { platform: response.platform } : {}),
    ...(response.coordinator_url !== undefined ? { coordinator_url: response.coordinator_url } : {}),
    ...(response.node_id !== undefined ? { node_id: response.node_id } : {}),
    ...(response.employee_id !== undefined ? { employee_id: response.employee_id } : {}),
    ...(response.display_name !== undefined ? { display_name: response.display_name } : {}),
    ...(response.rejection !== undefined ? { rejection: response.rejection } : {}),
    ...(response.pending_login !== undefined ? { pending_login: response.pending_login } : {}),
    ...(response.last_error !== undefined ? { last_error: response.last_error } : {}),
    ...(response.service_installed !== undefined ? { service_installed: response.service_installed } : {}),
  }
}

export function stoppedStatus(message = '无法读取本机设备状态，请检查日志'): DesktopStatus {
  return {
    state: 'stopped',
    registered: false,
    last_error: { code: 'status_unavailable', message, at: new Date().toISOString() },
  }
}

export function desktopStatusReason(status: DesktopStatus): string | undefined {
  return status.rejection?.message ?? status.last_error?.message
}
