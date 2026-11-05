import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultDataDirectory } from '../platform/layout.ts'
import { ControlClient } from './control-client.ts'
import { IPCError } from './ipc.ts'
import type { ControlResponse } from './control.ts'

export async function openLoginBrowser(url: string): Promise<void> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

const requireOK = (response: ControlResponse): ControlResponse => {
  if (!response.ok) throw new IPCError(response.code ?? 'control_failed', response.message ?? '本机控制请求失败')
  return response
}

export async function runControlCLI(
  action: 'login' | 'logout' | 'status',
  args: string[],
  dependencies: {
    readonly client?: Pick<ControlClient, 'request'>
    readonly openBrowser?: (url: string) => Promise<void>
    readonly signal?: AbortSignal
    readonly waitIntervalMs?: number
  } = {},
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: defaultDataDirectory() },
      ...(action === 'login'
        ? {
            coordinator: { type: 'string' as const },
            'display-name': { type: 'string' as const },
            cancel: { type: 'boolean' as const },
          }
        : {}),
    },
  })
  const client = dependencies.client ?? new ControlClient(values['data-dir']!)
  if (action !== 'login') {
    console.log(JSON.stringify(requireOK(await client.request({ method: action })), null, 2))
    return
  }
  if (values.cancel) {
    console.log(JSON.stringify(requireOK(await client.request({ method: 'login_cancel' }))))
    return
  }
  const coordinator =
    (typeof values.coordinator === 'string' ? values.coordinator : undefined) ??
    requireOK(await client.request({ method: 'status' })).coordinator_url
  if (!coordinator) throw new Error('首次登录需要 --coordinator https://中心地址')
  const started = requireOK(
    await client.request({
      method: 'login_start',
      coordinator_url: coordinator,
      ...(typeof values['display-name'] === 'string' ? { display_name: values['display-name'] } : {}),
    }),
  )
  console.log(JSON.stringify(started, null, 2))
  if (started.verification_uri_complete)
    await (dependencies.openBrowser ?? openLoginBrowser)(started.verification_uri_complete).catch(() => undefined)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  dependencies.signal?.addEventListener('abort', stop, { once: true })
  if (dependencies.signal?.aborted) stop()
  try {
    while (!controller.signal.aborted) {
      const current = requireOK(await client.request({ method: 'status' }))
      if (current.state === 'online') {
        console.log(JSON.stringify(current, null, 2))
        return
      }
      if (current.state === 'rejected')
        throw new IPCError(
          current.rejection?.code ?? 'login_rejected',
          current.rejection?.message ?? '节点连接已被拒绝',
        )
      if (current.state === 'unbound')
        throw new IPCError(
          current.last_error?.code ?? 'login_cancelled',
          current.last_error?.message ?? '设备登录已取消',
        )
      await delay(dependencies.waitIntervalMs ?? 250, undefined, { signal: controller.signal })
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', stop)
    dependencies.signal?.removeEventListener('abort', stop)
  }
}
