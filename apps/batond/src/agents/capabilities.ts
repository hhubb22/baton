import type { RuntimeAgent } from '@baton/protocol'

/** Steering follows upstream adapter capabilities; Thread model changes need Worker and host support. */
export const agentCapabilities = {
  cursor: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
  pi: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: false },
  codex: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: false },
  kiro: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
  shell: { create: true, queue: true, steer: false, stop: true, resume: false, switch_model: false },
} satisfies Record<string, RuntimeAgent['capabilities']>

const modelSwitchLimitation = 'Thread 内换模型未开放：Worker 固定模型，host 尚未将逐消息模型传给上游 startTurn'

export const capabilityLimitations = {
  cursor: `上游 adapter 不支持 steer；${modelSwitchLimitation}`,
  pi: modelSwitchLimitation,
  codex: modelSwitchLimitation,
  kiro: '上游 adapter 不支持 steer 和 Thread 内换模型',
}

const registered = new Map<string, RuntimeAgent['capabilities']>(Object.entries(agentCapabilities))

export const capabilitiesFor = (agentType: string) => registered.get(agentType)
