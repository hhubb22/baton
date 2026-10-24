import { agentCapabilities } from '../capabilities.ts'
import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory } from '../../worker/agent.ts'

export { probeCodex } from './probe.ts'

/** Worker-side factory for upstream Codex active steering. */
export const makeCodexAgentFactory = (options: Omit<AgentHostOptions, 'agentType' | 'steer'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'codex', steer: agentCapabilities.codex.steer })
