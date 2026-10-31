import type { AgentHostModule } from '../../agent-host/host.ts'
import { antigravityDriverLayer } from './host-driver.ts'

/** ACP owns its process group; the host registrar watches and reaps that group. */
export const antigravityAgentHostModule: AgentHostModule = {
  foldDetached: false,
  driver: ({ agentType, paths }) => antigravityDriverLayer({ agentType, paths }),
}
