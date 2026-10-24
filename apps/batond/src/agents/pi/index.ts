import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory, ThreadAgent } from '../../worker/agent.ts'

export { probePi } from './probe.ts'
export type { AgentDelta } from '../../agent-host/thread-agent.ts'
export type { AgentFactory, ThreadAgent }

/** Worker-side factory. Upstream Pi can steer; the worker command path still refuses it. */
export const makePiAgentFactory = (options: Omit<AgentHostOptions, 'agentType' | 'steer'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'pi', steer: true })
