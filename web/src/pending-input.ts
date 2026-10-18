export type PendingInput = { id: string; session: string }
const key = (employeeID: string) => `baton_pending_session_input:${employeeID}`

export function readPendingInput(employeeID: string): PendingInput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(employeeID)) ?? 'null') as PendingInput | null
    return value && typeof value.id === 'string' && typeof value.session === 'string' ? { id: value.id, session: value.session } : null
  } catch { return null }
}

export function savePendingInput(employeeID: string, value: PendingInput | null) {
  if (value) sessionStorage.setItem(key(employeeID), JSON.stringify({ id: value.id, session: value.session }))
  else sessionStorage.removeItem(key(employeeID))
}
