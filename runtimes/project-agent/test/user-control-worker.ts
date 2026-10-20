// Web E2E 通过真实 Runtime 检查模型请求和用户操作输入。
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { StdioClient } from '../../shared/stdio.js';
import { checkedRPC } from '../src/protocol.js';
import { ProjectRuntime } from '../src/runtime.js';

const client = new StdioClient(process.stdin, process.stdout);
const models = createModels();
const faux = fauxProvider({ provider: 'openai-codex', models: [{ id: 'fake-model' }] });
models.setProvider(faux.provider);
const respond = (context: any) => {
  const system = context.messages.find((m: any) => m.role === 'system');
  assert.match(system.content, /expected_outputs.*怎样验证完成/);
  assert.match(system.content, /找不到验证方式时写明原因/);
  assert.match(system.content, /不撤销用户的操作.*除非用户在对话里要求/);
  const dispatch = system.toolsAdded.find((tool: any) => tool.name === 'tasks_dispatch');
  assert.match(dispatch.description, /expected_outputs.*验证方式/);
  appendFileSync(process.env.BATON_TEST_CONTROL_REQUESTS!, JSON.stringify(context) + '\n');
  if (!context.messages.some((m: any) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'toolCall'))) {
    return fauxAssistantMessage([fauxToolCall('tasks_dispatch', {
      target_node_id: process.env.BATON_TEST_CONTROL_TARGET!, agent_type: 'pi', working_directory: process.env.BATON_TEST_CONTROL_WORKSPACE!,
      description: 'Project Agent 派出的运行中任务', expected_outputs: '检查任务执行记录和停止确认',
    }, { id: 'control-dispatch' })]);
  }
  return fauxAssistantMessage('已收到用户的任务结果和操作。');
};
faux.setResponses(Array.from({ length: 20 }, () => respond));
try {
  await new ProjectRuntime(checkedRPC((request) => client.call(request)), models, { now: () => performance.now(), sleep: async () => {} }).start();
} finally { process.stdin.destroy(); }
