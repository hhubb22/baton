/**
 * Environment handed to an Agent host and to the upstream adapter.
 *
 * Only runtime essentials and the configuration of the Agent being started are
 * passed through. Other providers' keys and Project Runtime credentials stay in
 * the Worker.
 */

const systemNames = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']

/** Provider-specific variables an Agent needs to reach its own account. */
const agentNames: Readonly<Record<string, readonly string[]>> = {
  cursor: ['CURSOR_API_KEY'],
}

export function agentEnvironment(agentType: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [...systemNames, ...(agentNames[agentType] ?? [])]
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** Host process environment: the same whitelist plus the batond command itself. */
export const hostEnvironment = agentEnvironment
