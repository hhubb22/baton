import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory } from '../../worker/agent.ts'

export { probeCodex } from './probe.ts'

/** Worker-side factory. Upstream Codex can steer; the worker command path still refuses it. */
export const makeCodexAgentFactory = (options: Omit<AgentHostOptions, 'agentType' | 'steer'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'codex', steer: true })
