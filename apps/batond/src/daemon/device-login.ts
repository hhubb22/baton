import { request } from 'node:https'
import { getCACertificates } from 'node:tls'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Schema } from 'effect'
import {
  DeviceLoginCreateInput,
  DeviceLoginCreateResponse,
  DeviceLoginTokenResponse,
  type NodeIdentity,
} from '@baton/protocol'
import { coordinatorURL, nodeSystem, saveDeviceIdentity } from './identity.ts'
import type { PendingLogin } from './control.ts'

export interface DeviceLoginTransport {
  (url: string, body: unknown, options: { readonly signal?: AbortSignal }): Promise<unknown>
}

/** The daemon owns the device code in memory. IPC only receives the public verification fields. */
export const deviceLoginHTTPS: DeviceLoginTransport = (url, body, options) =>
  new Promise((resolve, reject) => {
    const fail = () => reject(new Error('设备登录请求失败，请稍后重试'))
    const req = request(
      url,
      {
        method: 'POST',
        ca: getCACertificates('system'),
        minVersion: 'TLSv1.2',
        signal: options.signal,
        headers: { 'content-type': 'application/json', 'user-agent': 'batond' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 64 * 1024) {
            res.destroy()
            fail()
          } else chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            fail()
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            fail()
          }
        })
      },
    )
    req.setTimeout(30000, () => req.destroy())
    req.on('error', fail)
    req.end(JSON.stringify(body))
  })

export class DeviceLogin {
  private controller: AbortController | undefined
  private running: Promise<void> | undefined
  pending: PendingLogin | undefined
  constructor(
    readonly options: {
      readonly dataDirectory: string
      readonly transport?: DeviceLoginTransport
      readonly onApproved: (identity: NodeIdentity) => Promise<void>
      readonly onFinished: (code?: string) => Promise<void>
    },
  ) {}

  async start(rawURL: string, displayName?: string): Promise<PendingLogin> {
    const base = coordinatorURL(rawURL)
    const body = Schema.decodeUnknownSync(DeviceLoginCreateInput)({
      display_name: displayName ?? hostname(),
      system: nodeSystem(),
    })
    await this.cancel()
    const controller = new AbortController()
    this.controller = controller
    const transport = this.options.transport ?? deviceLoginHTTPS
    const session = Schema.decodeUnknownSync(DeviceLoginCreateResponse)(
      await transport(`${base}/api/v1/device-auth/sessions`, body, { signal: controller.signal }),
    )
    const { device_code: deviceCode, interval_seconds: intervalSeconds, ...publicSession } = session
    this.pending = { status: 'pending', ...publicSession }
    const deadline = performance.now() + session.expires_in_seconds * 1000
    this.running = (async () => {
      let interval = intervalSeconds
      while (!controller.signal.aborted && performance.now() < deadline) {
        await delay(interval * 1000, undefined, { signal: controller.signal })
        let response: typeof DeviceLoginTokenResponse.Type
        try {
          response = Schema.decodeUnknownSync(DeviceLoginTokenResponse)(
            await transport(
              `${base}/api/v1/device-auth/token`,
              { session_id: session.session_id, device_code: deviceCode },
              { signal: controller.signal },
            ),
          )
        } catch {
          if (controller.signal.aborted) return
          continue
        }
        if (controller.signal.aborted) return
        if (response.status === 'pending') {
          interval = response.interval_seconds
          continue
        }
        if (response.status === 'approved') {
          const identity = await saveDeviceIdentity(this.options.dataDirectory, response.identity, base)
          this.pending = undefined
          await this.options.onApproved(identity)
          return
        }
        this.pending = undefined
        await this.options.onFinished(`login_${response.status}`)
        return
      }
      if (!controller.signal.aborted) {
        this.pending = undefined
        await this.options.onFinished('login_expired')
      }
    })().catch(async () => {
      if (!controller.signal.aborted) {
        this.pending = undefined
        await this.options.onFinished('login_failed')
      }
    })
    return this.pending
  }

  async cancel(): Promise<void> {
    this.controller?.abort()
    await this.running
    this.controller = undefined
    this.running = undefined
    this.pending = undefined
  }
}
