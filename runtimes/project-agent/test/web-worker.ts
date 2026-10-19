// Web E2E 使用真实 Runtime，模型替身的故障和流速由测试控制。
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { existsSync } from 'node:fs';
import { StdioClient } from '../../shared/stdio.js';
import { checkedRPC } from '../src/protocol.js';
import { ProjectRuntime } from '../src/runtime.js';

const client = new StdioClient(process.stdin, process.stdout);
const models = createModels();
const faux = fauxProvider({ provider: 'openai-codex', models: [{ id: 'fake-model' }], tokensPerSecond: 8, tokenSize: { min: 8, max: 8 } });
models.setProvider(faux.provider);
const response = () => {
  if (!existsSync(process.env.BATON_TEST_WEB_RECOVER!)) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '测试模型故障' });
  // 工具结果已保存后恢复时直接回复，避免派发重复任务。
  return fauxAssistantMessage('已读取项目记录，继续处理工作。'.repeat(12));
};
const scripted = [
  (context: any) => context.messages.some((m: any) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "toolCall")) ? response() : !existsSync(process.env.BATON_TEST_WEB_RECOVER!) ? response() : fauxAssistantMessage([
    fauxToolCall('tasks.dispatch', { target_node_id: process.env.BATON_TEST_WEB_TARGET!, agent_type: 'pi', working_directory: process.env.BATON_TEST_WEB_WORKSPACE!, description: 'Project Agent 派出的验证任务', expected_outputs: '检查输出与证据' }, { id: 'web-dispatch' }),
    fauxToolCall('memory.write', { title: '设备约定', content: '保留跨设备工作记录', expected_revision: 0 }, { id: 'web-memory' }),
  ]),
  ...Array.from({ length: 8 }, () => response),
];
faux.setResponses(scripted);
try {
  await new ProjectRuntime(checkedRPC((request) => client.call(request)), models, {
    now: () => performance.now(), sleep: async () => {},
  }).start();
} finally { process.stdin.destroy(); }
