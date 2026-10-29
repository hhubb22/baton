declare const __BATON_BUILD__: { version: string; commit: string }

type Failure = {
  time: string
  trace_id?: string
  error_code?: string
  thread_id?: string
  project_id?: string
  device_id?: string
}

let latest: Failure | undefined
let latestPath: string | undefined
const listeners = new Set<() => void>()
export const subscribeFailures = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const hasFailure = () => latest !== undefined
export const resetFailures = () => {
  latest = undefined
  latestPath = undefined
  for (const listener of listeners) listener()
}
export const clearFailure = (path: string) => {
  if (latestPath === path) resetFailures()
}
const codes = new Set([
  'invalid_credentials',
  'password_change_required',
  'invalid_password',
  'password_reused',
  'csrf_rejected',
  'origin_rejected',
  'forbidden',
  'revoked',
  'path_changed',
  'directory_changed',
  'roots_changed',
  'file_changed',
  'thinking_unavailable',
  'conflict',
  'core_budget_exceeded',
  'credential_changed',
  'database_required',
  'display_name_required',
  'embedding_dimension_mismatch',
  'enrollment_expired',
  'incarnation_conflict',
  'invalid',
  'invalid_command',
  'invalid_configuration',
  'invalid_core_source',
  'invalid_cursor',
  'invalid_employee',
  'invalid_enrollment',
  'invalid_evidence',
  'invalid_fact_time',
  'invalid_frame',
  'invalid_id',
  'invalid_json',
  'invalid_migration',
  'invalid_node',
  'invalid_node_credential',
  'invalid_node_response',
  'invalid_offset',
  'invalid_origins',
  'invalid_path',
  'invalid_provider',
  'invalid_query',
  'invalid_range',
  'invalid_request',
  'invalid_revocation_concurrency',
  'invalid_revocation_page',
  'invalid_runtime_report',
  'invalid_schema',
  'invalid_signing_key',
  'invalid_successor',
  'invalid_support',
  'invalid_suppression',
  'invalid_tls',
  'invalid_tool_output',
  'invalid_ttl',
  'json_required',
  'max_bytes_too_small',
  'memory_context_changed',
  'memory_unavailable',
  'migration_checksum_mismatch',
  'missing_correlation',
  'node_busy',
  'node_idle_expired',
  'node_offline',
  'node_source_rejected',
  'node_syncing',
  'node_timeout',
  'node_unavailable',
  'not_found',
  'not_text',
  'operation_conflict',
  'output_identity_mismatch',
  'output_unavailable',
  'project_archived',
  'reauth_conflict',
  'revocation_pending',
  'route_forbidden',
  'runtime_report_unavailable',
  'server_stopping',
  'session_expired',
  'shell_requires_exec',
  'snapshot_cursor_required',
  'source_suppressed',
  'storage_version_unsupported',
  'unauthenticated',
  'unauthorized',
  'unavailable',
  'unknown_tool',
  'unsupported_message',
  'upgrade_conflict',
  'username_required',
  'username_taken',
])

export function recordFailure(path: string, traceResponse: string | null, errorCode: unknown) {
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceResponse ?? '')
  const target =
    /^\/(threads|projects|nodes)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path)
  latest = {
    time: new Date().toISOString(),
    ...(match && !/^0+$/.test(match[1]!) ? { trace_id: match[1] } : {}),
    error_code: typeof errorCode === 'string' && codes.has(errorCode) ? errorCode : 'invalid',
    ...(target?.[1] === 'threads' ? { thread_id: target[2] } : {}),
    ...(target?.[1] === 'projects' ? { project_id: target[2] } : {}),
    ...(target?.[1] === 'nodes' ? { device_id: target[2] } : {}),
  }
  latestPath = path
  for (const listener of listeners) listener()
}

export function diagnosticText() {
  return JSON.stringify(
    {
      time: latest?.time ?? new Date().toISOString(),
      web_version: __BATON_BUILD__.version,
      web_commit: __BATON_BUILD__.commit,
      ...latest,
    },
    null,
    2,
  )
}
