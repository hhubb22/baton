import type { AgentHostModule } from '../../agent-host/host.ts'
import { droidDriverLayer } from './host-driver.ts'

/** ACP owns its process group; the host registrar watches and reaps that group. */
export const droidAgentHostModule: AgentHostModule = {
  foldDetached: false,
  driver: ({ agentType, paths }) => droidDriverLayer({ agentType, paths }),
}
