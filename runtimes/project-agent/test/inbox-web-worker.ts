// Web E2E 运行真实 Runtime；模型替身依次新建 Thread、创建事项并接收用户回答。
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { existsSync, readFileSync } from 'node:fs';
import { StdioClient } from '../../shared/stdio.js';
import { checkedRPC } from '../src/protocol.js';
import { ProjectRuntime } from '../src/runtime.js';

const client = new StdioClient(process.stdin, process.stdout);
const models = createModels();
const faux = fauxProvider({ provider: 'openai-codex', models: [{ id: 'fake-model' }] });
models.setProvider(faux.provider);
const response = async (context: any) => {
  const called = (name: string) => context.messages.some((m: any) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'toolCall' && b.name === name));
  if (called('inbox.ask')) return fauxAssistantMessage('已收到输入并保留事项处理记录。');
  if (!called('threads.create')) return fauxAssistantMessage([fauxToolCall('threads.create', {
    node_id: process.env.BATON_TEST_WEB_TARGET!, agent_type: 'pi', working_directory: process.env.BATON_TEST_WEB_WORKSPACE!, message: 'Inbox 验证：保存结果和回复',
  }, { id: 'inbox-web-create' })]);
  const deadline = Date.now() + 60_000;
  while (!existsSync(process.env.BATON_TEST_INBOX_READY!)) {
    if (Date.now() > deadline) throw new Error('等待 Thread 回复超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const threadID = readFileSync(process.env.BATON_TEST_INBOX_READY!, 'utf8').trim();
  return fauxAssistantMessage([1, 2, 3].map((index) => fauxToolCall('inbox.ask', {
    title: `重连检查 ${index}`, thread_id: threadID,
    content: '**重连检查**\n\n| 检查 | 结果 |\n| - | - |\n| 日志 | 待核实 |\n\n```text\n检查日志\n```\n\n[详情](https://example.org/proof)\n\n<img src="https://example.org/x" onerror="window.inboxPwned=true">\n\n' + 'q'.repeat(10 * 1024),
    options: [{ id: 'fix', label: '调查并修复', recommended: true }, { id: 'wait', label: '稍后处理' }], allow_text: true,
  }, { id: `inbox-web-ask-${index}` })));
};
faux.setResponses(Array.from({ length: 50 }, () => response));
try {
  await new ProjectRuntime(checkedRPC((request) => client.call(request)), models, { now: () => performance.now(), sleep: async () => {} }).start();
} finally { process.stdin.destroy(); }
