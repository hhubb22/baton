import type { AgentHostModule } from '../../agent-host/host.ts'
import { kiroDriverLayer } from './host-driver.ts'

/** ACP owns its process group; the host registrar watches and reaps that group. */
export const kiroAgentHostModule: AgentHostModule = {
  foldDetached: false,
  driver: ({ agentType, paths }) => kiroDriverLayer({ agentType, paths }),
}
