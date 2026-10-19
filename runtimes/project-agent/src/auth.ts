import { homedir } from "node:os";
import { join } from "node:path";
import { FileCredentials } from "./credentials.js";

export const VERSION = "0.1.0";
export const PROVIDERS = ["openai-codex", "xai"];
export function credentials() {
  return new FileCredentials(
    process.env.BATON_PROJECT_RUNTIME_DATA_DIR ??
      join(homedir(), ".baton", "project-runtime"),
  );
}
// probe 只读本地状态，既不刷新 OAuth，也不构造 Models 或调用 provider。
export async function probe(store = credentials()) {
  const providers = [];
  for (const provider of PROVIDERS) {
    let status = "login_required";
    try {
      const credential = await store.read(provider);
      if (
        credential?.type === "oauth" &&
        credential.refresh &&
        credential.access
      )
        status = "available";
    } catch {
      status = "unknown";
    }
    providers.push({ provider, status });
  }
  return { version: VERSION, providers };
}
export async function runtimeModels() {
  const [{ createModels }, { openaiCodexProvider }, { xaiProvider }] =
    await Promise.all([
      import("@earendil-works/pi-ai/models"),
      import("@earendil-works/pi-ai/providers/openai-codex"),
      import("@earendil-works/pi-ai/providers/xai"),
    ]);
  const models = createModels({
    credentials: credentials(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(xaiProvider());
  return models;
}
