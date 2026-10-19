import { StdioClient } from "../../shared/stdio.js";
import { checkedRPC } from "../src/protocol.js";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { assistant } from "./fixture.js";
import { ProjectRuntime } from "../src/runtime.js";
const client = new StdioClient(process.stdin, process.stdout);
let now = 0;
const rpc = checkedRPC(async (request) => {
  if (request.operation === "poll_wake")
    now += (request.payload as any).wait_ms;
  return client.call(request);
});
const models = createModels();
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
models.setProvider(faux.provider);
faux.setResponses(
  Array.from(
    { length: 6 },
    () => (context: any) =>
      context.messages.at(-1)?.role === "toolResult"
        ? assistant()
        : assistant(true),
  ),
);
try {
  await new ProjectRuntime(rpc, models, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  }).start();
} finally {
  process.stdin.destroy();
}
