export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
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
