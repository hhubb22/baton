import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory } from '../../worker/agent.ts'

export { probeCursor } from './probe.ts'

/** Worker-side factory: one Agent host process per execution lifetime. */
export const makeCursorAgentFactory = (options: Omit<AgentHostOptions, 'agentType'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'cursor' })
