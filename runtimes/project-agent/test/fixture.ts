import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Bootstrap, Event, RPC } from "../src/protocol.js";
import { RuntimeError } from "../src/protocol.js";
import { ProjectRuntime, type Clock } from "../src/runtime.js";
import type { CompactionSettings } from "../src/compaction.js";

export const assistant = (
  tools = false,
  threadTool: "threads.create" | "threads.send" = "threads.create",
) =>
  fauxAssistantMessage(
    tools
      ? [
          fauxToolCall(
            threadTool,
            threadTool === "threads.create"
              ? {
                  node_id: "node-b",
                  agent_type: "codex",
                  working_directory: "/repo",
                  message: "验证并检查结果",
                }
              : { thread_id: "thread-1", message: "继续验证并检查结果" },
            { id: threadTool === "threads.create" ? "create-1" : "send-1" },
          ),
        ]
      : fauxText("完成"),
    { timestamp: 123 },
  );
export const input = (): Event => ({
  seq: 1,
  kind: "input",
  payload: {
    format: "pi-ai/1",
    message: {
      role: "user",
      content: [{ type: "text", text: "请开启 Thread 并验证结果" }],
      timestamp: 0,
    },
  },
});
export class Backend implements RPC {
  events: Event[] = [];
  queue = true;
  effects = 0;
  calls: string[] = [];
  now = 0;
  failAt = "";
  pageSize = 2;
  compactions = new Map<string, Event>();
  boot(): Bootstrap {
    const compaction = this.events.findLast((e) => e.kind === "compaction");
    return {
      compaction: compaction ? structuredClone(compaction) : undefined,
      compaction_seq: compaction?.seq,
      project: {
        title: "Baton",
        goal: "跨设备接续 🐈",
        agent: { provider: "faux", model: "faux-model" },
        conversation: { id: "conversation-stable" },
      },
      prompt_version: "1",
      after_seq: compaction?.payload.through_seq ?? 0,
      last_seq: this.events.length,
    };
  }
  async call(req: any): Promise<any> {
    this.calls.push(req.operation);
    if (req.operation === this.failAt) throw new RuntimeError("unavailable");
    switch (req.operation) {
      case "preview":
        return {};
      case "bootstrap":
        return structuredClone(this.boot());
      case "read_events": {
        const events = this.events
          .filter((e) => e.seq > req.after_seq)
          .slice(0, this.pageSize);
        return structuredClone({
          events,
          last_seq: this.events.length,
          next_after_seq: events.at(-1)?.seq ?? req.after_seq,
          has_more: (events.at(-1)?.seq ?? req.after_seq) < this.events.length,
        });
      }
      case "claim_inputs": {
        if (!this.queue) return {};
        this.queue = false;
        const event = input();
        event.seq = this.events.length + 1;
        this.events.push(event);
        return { event: structuredClone(event) };
      }
      case "commit_compaction": {
        const saved = this.compactions.get(req.client_event_id);
        if (saved) return structuredClone(saved);
        if (req.last_seq !== this.events.length)
          throw new RuntimeError("conflict");
        const event: Event = {
          seq: this.events.length + 1,
          kind: "compaction",
          payload: structuredClone(req.payload),
        };
        this.events.push(event);
        this.compactions.set(req.client_event_id, event);
        return structuredClone(event);
      }
      case "append_event": {
        if (req.last_seq !== this.events.length)
          throw new RuntimeError("conflict");
        const event: Event = {
          seq: this.events.length + 1,
          kind: "assistant",
          payload: structuredClone(req.payload),
        };
        this.events.push(event);
        return structuredClone(event);
      }
      case "call_tool": {
        const saved = this.events.find(
          (e) =>
            e.kind === "tool_result" &&
            e.payload.message.toolCallId === req.tool_call_id,
        );
        if (saved) return structuredClone(saved);
        if (
          req.last_seq !== this.events.length ||
          !this.events.some((e) => e.kind === "assistant")
        )
          throw new Error("工具越过保存屏障");
        this.effects++;
        const event: Event = {
          seq: this.events.length + 1,
          kind: "tool_result",
          payload: {
            format: "pi-ai/1",
            message: {
              role: "toolResult",
              toolCallId: req.tool_call_id,
              toolName: req.tool_name,
              content: [{ type: "text", text: '{"thread_id":"thread-1"}' }],
              isError: false,
              timestamp: 0,
            },
          },
        };
        this.events.push(event);
        return structuredClone(event);
      }
      case "poll_wake":
        this.now += req.payload?.wait_ms ?? 25_000;
        return { wake: false };
      case "finish":
      case "report_failure":
        return {};
      default:
        throw new Error("未知操作 " + req.operation);
    }
  }
  timer(): Clock {
    return {
      now: () => this.now,
      sleep: async (ms) => {
        this.now += ms;
      },
    };
  }
}
export function setup(
  backend: Backend,
  responses?: any[],
  options: {
    contextWindow?: number;
    compaction?: Partial<CompactionSettings>;
  } = {},
) {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      {
        id: "faux-model",
        maxTokens: 32000,
        contextWindow: options.contextWindow ?? 1_000_000,
      },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: any[] = [];
  const response = (context: TranscriptContext, options: any) => {
    return context.messages.at(-1)?.role === "toolResult"
      ? assistant()
      : assistant(true);
  };
  faux.setResponses(
    (responses ?? [response, response]).map(
      (step) => (context: any, options: any, state: any, model: any) => {
        requests.push(
          structuredClone({
            context,
            maxTokens: options.maxTokens,
            sessionId: options.sessionId,
            maxRetries: options.maxRetries,
            ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
          }),
        );
        return typeof step === "function"
          ? step(context, options, state, model)
          : step;
      },
    ),
  );
  return {
    runtime: new ProjectRuntime(
      backend,
      models,
      backend.timer(),
      options.compaction,
    ),
    faux,
    requests,
  };
}
