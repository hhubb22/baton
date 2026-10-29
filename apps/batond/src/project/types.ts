import { Schema } from 'effect'
import type {
  ModelConnection,
  ProjectRunCommand,
  ProjectRuntime,
  ProjectRuntimeRequest,
  ProjectRuntimeResult,
} from '@baton/protocol'
import type { ProcessCommand } from '../platform/process.ts'

export type ProjectTransport = (request: ProjectRuntimeRequest, signal: AbortSignal) => Promise<ProjectRuntimeResult>
export interface ProjectClock {
  wall(): number
  monotonic(): number
}
export interface ProjectManagerOptions {
  dataDir: string
  nodeId?: string
  runtimeCommand?: ProcessCommand
  watchdogCommand?: ProcessCommand
  clock?: ProjectClock
  timing?: { renewMs?: number; leaseMs?: number; checkMs?: number }
  onReportChanged?: () => void
}
export const DeviceLoginCode = Schema.Struct({
  type: Schema.Literal('device_code'),
  provider: Schema.Literals(['openai-codex', 'xai']),
  verification_uri: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
  user_code: Schema.String.check(Schema.isBetweenCodePoints(1, 256)),
  expires_in_seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
})
export type DeviceLoginCode = typeof DeviceLoginCode.Type
export interface ProjectManager {
  leaseWaitAge?(): number
  setTransport(request?: ProjectTransport): void
  onDisconnect(): void
  command(command: ProjectRunCommand): Promise<void>
  probe(signal?: AbortSignal): Promise<ProjectRuntime>
  report(signal?: AbortSignal): Promise<ProjectRuntime | undefined>
  login(provider: string, signal?: AbortSignal): Promise<void>
  subscriptions(signal?: AbortSignal): Promise<ProjectRuntime>
  configureConnection?(
    action: 'save' | 'delete' | 'get',
    connection: ModelConnection,
    signal?: AbortSignal,
  ): Promise<ModelConnection | undefined>
  logout?(provider: string, signal?: AbortSignal): Promise<void>
  startDeviceLogin(provider: string, signal?: AbortSignal, onDone?: () => void): Promise<DeviceLoginCode>
  close(): Promise<void>
}
export const MAX_FRAME = 192 * 1024
export const failure = (code: string): ProjectRuntimeResult => ({ type: 'project_runtime.result', ok: false, code })
export const success = (data: ProjectRuntimeResult['data']): ProjectRuntimeResult => ({
  type: 'project_runtime.result',
  ok: true,
  ...(data === undefined ? {} : { data }),
})

export class LeaseClock {
  private readonly wallStart: number
  private readonly monoStart: number
  private previous = 0
  constructor(
    private readonly clock: ProjectClock = {
      wall: () => Date.now(),
      monotonic: () => Number(process.hrtime.bigint()) / 1e6,
    },
  ) {
    this.wallStart = clock.wall()
    this.monoStart = clock.monotonic()
  }
  now(): number {
    const now = Math.max(this.clock.wall() - this.wallStart, this.clock.monotonic() - this.monoStart)
    if (!Number.isFinite(now) || now < this.previous) throw new Error('Project Runtime 时钟不可用')
    this.previous = now
    return now
  }
}
