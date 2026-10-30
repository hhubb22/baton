import { agentCatalog } from './catalog.ts'
import { makeAgentHostFactory } from '../agent-host/thread-agent.ts'
import { AgentError, type AgentFactory } from '../worker/agent.ts'
import type { ProcessCommand, ProcessRecordCallbacks, ProcessWatchdog } from '../platform/process.ts'

export function makeThreadAgentFactory(options: {
  readonly dataDirectory: string
  readonly command: ProcessCommand
  readonly records: ProcessRecordCallbacks
  readonly watchdog?: ProcessWatchdog
}): AgentFactory {
  return (config) => {
    if (!Object.hasOwn(agentCatalog, config.agent_type))
      throw new AgentError(`Unsupported Thread agent_type: ${config.agent_type}`)
    const type = config.agent_type as keyof typeof agentCatalog
    return makeAgentHostFactory({
      command: options.command,
      records: options.records,
      ...(options.watchdog ? { watchdog: options.watchdog } : {}),
      agentType: type,
      capabilities: agentCatalog[type].capabilities,
    })(config)
  }
}
