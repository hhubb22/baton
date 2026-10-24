import { cursorAgentHostModule } from '../agents/cursor/host-module.ts'
import { piAgentHostModule } from '../agents/pi/host-module.ts'
import { runAgentHost, type AgentHostModule } from './host.ts'
import type { AgentHostPaths } from './host-layer.ts'

const modules: Readonly<Record<string, AgentHostModule>> = {
  cursor: cursorAgentHostModule,
  pi: piAgentHostModule,
}

export const agentHostModule = (agentType: string): AgentHostModule | undefined => modules[agentType]

export const runAgentHostCommand = (agentType: string, paths: AgentHostPaths) => {
  const module = agentHostModule(agentType)
  if (!module) throw new Error(`Unknown Agent host type: ${agentType}`)
  return runAgentHost(module, { agentType, paths })
}

export type { AgentHostModule } from './host.ts'
export type { AgentHostPaths } from './host-layer.ts'
export { makeAgentHostFactory, type AgentDelta, type AgentHostOptions } from './thread-agent.ts'
export { connectAgentHost, agentHostArguments, type AgentHostConnection } from './transport.ts'
export { AgentHostError, type HostEvent, type ProbeResult } from './protocol.ts'
