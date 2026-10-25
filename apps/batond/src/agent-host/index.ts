import { Effect } from 'effect'
import { runAgentHost, type AgentHostModule } from './host.ts'
import type { AgentHostPaths } from './host-layer.ts'

const modules: Readonly<Record<string, () => Promise<AgentHostModule>>> = {
  cursor: () => import('../agents/cursor/host-module.ts').then((module) => module.cursorAgentHostModule),
  pi: () => import('../agents/pi/host-module.ts').then((module) => module.piAgentHostModule),
  codex: () => import('../agents/codex/host-module.ts').then((module) => module.codexAgentHostModule),
  kiro: () => import('../agents/kiro/host-module.ts').then((module) => module.kiroAgentHostModule),
}

export const agentHostModuleNames = (): string[] => Object.keys(modules)

export const agentHostModule = async (agentType: string): Promise<AgentHostModule | undefined> =>
  Object.hasOwn(modules, agentType) ? modules[agentType]!() : undefined

export const runAgentHostCommand = Effect.fn('AgentHost.runAgentHostCommand')(function* (
  agentType: string,
  paths: AgentHostPaths,
) {
  const module = yield* Effect.tryPromise(() => agentHostModule(agentType))
  if (!module) return yield* Effect.fail(new Error(`Unknown Agent host type: ${agentType}`))
  return yield* runAgentHost(module, { agentType, paths })
})
