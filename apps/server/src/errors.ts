import type { AttentionRequest, ProjectMemory } from '@baton/protocol'

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly details?: {
      readonly current?: ProjectMemory | AttentionRequest | null
      readonly current_revision?: number
    },
  ) {
    super(message)
  }
}

export interface NodeSource {
  readonly employee_id: string
  readonly node_id: string
  readonly credential_id: string
  readonly incarnation: string
  readonly conn_id: string
}
