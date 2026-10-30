import { resolveEnvironment } from '../environment.ts'

export function agentEnvironment(agentType: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return resolveEnvironment({ version: 1, revision: '', imported: {}, scopes: {} }, source, { agent: agentType }).env
}
