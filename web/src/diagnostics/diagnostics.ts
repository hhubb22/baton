declare const __BATON_BUILD__: { version: string; commit: string }

type Failure = {
  time: string
  client_version: string
  server_version?: string
  request_id?: string
  error_code?: string
  thread_id?: string
  project_id?: string
  device_id?: string
}

let latest: Failure | undefined
let latestPath: string | undefined
let serverVersion: string | undefined
const listeners = new Set<() => void>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const version = /^[0-9A-Za-z.+_-]{1,64}$/
const code = /^[a-z][a-z0-9_]{0,63}$/
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

export function recordServerVersion(value: string | null) {
  if (value && version.test(value)) serverVersion = value
}

/** Keep only identifiers and a fixed error code; request bodies and messages never enter the summary. */
export function recordFailure(path: string, requestId: string | null, errorCode: unknown) {
  const target =
    /^\/(threads|projects|nodes)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path)
  latest = {
    time: new Date().toISOString(),
    client_version: __BATON_BUILD__.version,
    ...(serverVersion ? { server_version: serverVersion } : {}),
    ...(requestId && uuid.test(requestId) ? { request_id: requestId.toLowerCase() } : {}),
    error_code: typeof errorCode === 'string' && code.test(errorCode) ? errorCode : 'invalid',
    ...(target?.[1] === 'threads' ? { thread_id: target[2] } : {}),
    ...(target?.[1] === 'projects' ? { project_id: target[2] } : {}),
    ...(target?.[1] === 'nodes' ? { device_id: target[2] } : {}),
  }
  latestPath = path
  for (const listener of listeners) listener()
}

export function diagnosticText() {
  return JSON.stringify(
    latest ?? {
      time: new Date().toISOString(),
      client_version: __BATON_BUILD__.version,
      ...(serverVersion ? { server_version: serverVersion } : {}),
      error_code: 'invalid',
    },
    null,
    2,
  )
}
