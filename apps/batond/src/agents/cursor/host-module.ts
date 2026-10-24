import { Layer } from 'effect'
import type { AgentHostModule } from '../../agent-host/host.ts'
import { cursorHostDriver } from './host-driver.ts'
import { cursorRunnerLayer } from './sdk-layer.ts'

/** Agent host module registered for the `cursor` Agent type. */
export const cursorAgentHostModule: AgentHostModule = {
  driver: ({ agentType }) => cursorHostDriver({ agentType }).pipe(Layer.provide(cursorRunnerLayer)),
}
