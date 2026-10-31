import type { RuntimeAgent } from '@baton/protocol'

/** 能力由固定的上游 adapter 提供。 */
export const agentCatalog = {
  cursor: {
    kind: 'hosted',
    name: 'Cursor',
    capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
    limitation: '上游 adapter 不支持 steer',
  },
  pi: {
    kind: 'hosted',
    name: 'Pi',
    capabilities: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: true },
    limitation: '',
  },
  codex: {
    kind: 'hosted',
    name: 'Codex',
    capabilities: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: true },
    limitation: '',
  },
  kiro: {
    kind: 'hosted',
    name: 'Kiro',
    capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
    limitation: '上游 adapter 不支持 steer 和 Thread 内换模型',
  },
  antigravity: {
    kind: 'hosted',
    name: 'Antigravity',
    capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
    limitation: '上游 adapter 不支持 steer',
  },
} as const satisfies Record<
  string,
  {
    kind: 'hosted'
    name: string
    capabilities: RuntimeAgent['capabilities']
    limitation: string
  }
>

export type HostedAgentType = {
  [K in keyof typeof agentCatalog]: (typeof agentCatalog)[K]['kind'] extends 'hosted' ? K : never
}[keyof typeof agentCatalog]
