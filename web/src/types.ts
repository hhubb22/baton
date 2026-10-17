export type Employee = {
  id: string
  username: string
  display_name: string
  auth_source: string
  must_change_password: boolean
}

export type LoginResponse = {
  employee: Employee
  csrf_token: string
  expires_at: string
}

export type MeResponse = {
  employee: Employee
  expires_at?: string
}

export type RevocationStatus = 'none' | 'pending' | 'effective'

export type Revocation = {
  status: string
  operator_id: string
  credential_ids: string[]
  requested_at: string
  applied_at: string | null
  message: string
  local_process_notice: string
}

export type NodeStatus = {
  id: string
  display_name: string
  system: string
  role: string
  capabilities: string[]
  registration_seq: number
  online: boolean
  last_contact_at: string | null
  status_updated_at: string | null
  synced: boolean
  executable: boolean
  revocation_status: RevocationStatus | string
  revocation?: Revocation
}

export type DefaultPC = {
  node_id: string
  invalid: boolean
  needs_reselection: boolean
  message?: string
}

export type NodeList = {
  nodes: NodeStatus[]
  default_pc: DefaultPC
  local_process_notice: string
}

export type SavedDefault = {
  default_pc_node_id: string
  display_name: string
  system: string
  role: string
  registration_seq: number
}

export type RevokeResult = {
  node_id: string
  status: string
  operator_id: string
  credential_ids: string[]
  requested_at: string
  applied_at: string | null
  message: string
  local_process_notice: string
  default_pc: DefaultPC
}

export type Enrollment = {
  enrollment_id: string
  enrollment_token: string
  expires_at: string
}
