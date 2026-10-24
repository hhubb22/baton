import { agentCapabilities } from '../capabilities.ts'
import { makeAgentHostFactory, type AgentHostOptions } from '../../agent-host/thread-agent.ts'
import type { AgentFactory, ThreadAgent } from '../../worker/agent.ts'

export { probePi } from './probe.ts'
export type { AgentDelta } from '../../agent-host/thread-agent.ts'
export type { AgentFactory, ThreadAgent }

/** Worker-side factory for upstream Pi active steering. */
export const makePiAgentFactory = (options: Omit<AgentHostOptions, 'agentType' | 'steer'>): AgentFactory =>
  makeAgentHostFactory({ ...options, agentType: 'pi', steer: agentCapabilities.pi.steer })
