import type { Topic } from '../client'
import type { Device, ID, Operation, OperationKind, OperationPhase } from '../types'

export interface HttpContext {
  request<T>(path: string, init?: RequestInit): Promise<T>
  emit(...topics: Topic[]): void
  devices(): Promise<Device[]>
  operation(
    kind: OperationKind,
    targetId: ID,
    phase: OperationPhase,
    detail?: string | null,
    refresh?: () => Promise<{ phase: OperationPhase; detail?: string | null }>,
  ): Operation
}

export const apiPath = (id: ID) => encodeURIComponent(id)
export const timestamp = (value: string | number | null | undefined) =>
  value == null ? 0 : typeof value === 'number' ? value : Date.parse(value)
