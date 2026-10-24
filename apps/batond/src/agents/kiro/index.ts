import { agentCapabilities } from '../capabilities.ts'
import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory } from '../../worker/agent.ts'

export { probeKiro } from './probe.ts'

/** Worker-side factory for the upstream Kiro ACP adapter. */
export const makeKiroAgentFactory = (options: Omit<AgentHostOptions, 'agentType' | 'steer'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'kiro', steer: agentCapabilities.kiro.steer })
