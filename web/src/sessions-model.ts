import type { WorkSession } from './ui/SessionsPage.tsx'

export function sessionDepth(item: WorkSession, sessions: WorkSession[]): number {
  const seen = new Set([item.session_id])
  let depth = 0
  let parent = item.parent_session_id
  while (parent && depth < 20) {
    const next = sessions.find((s) => s.session_id === parent && s.node_id === item.node_id)
    if (!next || seen.has(next.session_id)) break
    seen.add(next.session_id); depth += 1; parent = next.parent_session_id
  }
  return depth
}

export function appendOutput(current: string, text: string): string {
  const bytes = new TextEncoder().encode(current + text)
  return new TextDecoder().decode(bytes.slice(-128 * 1024))
}


export function orderedSessions(sessions: WorkSession[], nodeID: string): WorkSession[] {
 const local = sessions.filter((s) => s.node_id === nodeID)
 const ids = new Set(local.map((s) => s.session_id))
 const seen = new Set<string>()
 const result: WorkSession[] = []
 const visit = (item: WorkSession) => {
  if (seen.has(item.session_id)) return
  seen.add(item.session_id); result.push(item)
  local.filter((s) => s.parent_session_id === item.session_id).forEach(visit)
 }
 local.filter((s) => !s.parent_session_id || !ids.has(s.parent_session_id)).forEach(visit)
 local.forEach(visit)
 return result
}
