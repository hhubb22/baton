import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory, ThreadAgent } from '../../worker/agent.ts'

export { probeCursor } from './probe.ts'
export type { AgentDelta } from '../../agent-host/thread-agent.ts'
export type { AgentFactory, ThreadAgent }

/** Worker-side factory: one Agent host process per execution lifetime. */
export const makeCursorAgentFactory = (options: Omit<AgentHostOptions, 'agentType'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'cursor' })
