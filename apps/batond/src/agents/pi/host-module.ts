import type { AgentHostModule } from '../../agent-host/host.ts'
import { piHostDriver } from './host-driver.ts'

/** Pi keeps the process group it creates so `kill(-pid)` still reaches its children. */
export const piAgentHostModule: AgentHostModule = {
  foldDetached: false,
  driver: ({ agentType }) => piHostDriver({ agentType }),
}
