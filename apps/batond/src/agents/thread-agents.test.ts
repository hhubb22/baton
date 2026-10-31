import { expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { AgentError } from '../worker/agent.ts'
import { makeThreadAgentFactory } from './thread-agents.ts'

it('constructs hosted agents without filesystem or process work and rejects invalid configurations synchronously', () => {
  const factory = makeThreadAgentFactory({
    dataDirectory: '/missing-baton-data',
    command: { file: '/missing-batond' },
    records: { add: async () => {}, remove: async () => {} },
  })
  const config = {
    agent_type: 'cursor',
    working_directory: '/missing-baton-workspace',
    adapter_config: { state_path: '/missing-baton-private/native.json' },
  } as WorkerOpenConfig
  for (const agent_type of ['cursor', 'pi', 'codex', 'kiro', 'antigravity'] as const) {
    expect(factory({ ...config, agent_type }).open).toBeTypeOf('function')
  }
  for (const agent_type of ['unknown', 'constructor', '__proto__']) {
    expect(() => factory({ ...config, agent_type } as WorkerOpenConfig)).toThrow(AgentError)
  }
  expect(() => factory({ ...config, working_directory: 'relative' })).toThrow(AgentError)
  expect(() => factory({ ...config, adapter_config: { state_path: 'relative/native.json' } })).toThrow(AgentError)
})
