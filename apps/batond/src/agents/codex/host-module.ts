import type { AgentHostModule } from '../../agent-host/host.ts'
import { codexDriverLayer } from './host-driver.ts'

/** Codex app-server is its own process group, same as Pi. */
export const codexAgentHostModule: AgentHostModule = {
  foldDetached: false,
  driver: ({ agentType, paths }) => codexDriverLayer({ agentType, paths }),
}
