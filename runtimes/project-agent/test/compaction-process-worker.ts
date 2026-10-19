import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { StdioClient } from "../../shared/stdio.js";
import { checkedRPC } from "../src/protocol.js";
import { ProjectRuntime } from "../src/runtime.js";
const client = new StdioClient(process.stdin, process.stdout);
let now = 0;
const models = createModels();
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: Number(process.env.BATON_TEST_COMPACTION_WINDOW) }] });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("目标、决定和待处理事项摘要")));
const rpc = checkedRPC(async (req) => {
  if (req.operation === "poll_wake") now += (req.payload as any).wait_ms;
  return client.call(req);
});
try {
  await new ProjectRuntime(rpc, models, { now: () => now, sleep: async (ms) => { now += ms; } }).start();
} finally { process.stdin.destroy(); }
