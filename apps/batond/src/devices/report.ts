import type { RuntimeReport } from '@baton/protocol'

/** 缩进 JSON 为 jsonb 空格预留容量，先裁仓库，再裁模型，最后裁目录。 */
export function boundRuntimeReport(report: RuntimeReport): RuntimeReport {
  const roots = [...(report.roots ?? [])],
    repos = [...(report.repos ?? [])]
  const agents = (report.agents ?? []).map((agent) => ({ ...agent, models: [...(agent.models ?? [])] }))
  const providers = (report.project_runtime?.providers ?? []).map((provider) => ({
    ...provider,
    models: [...(provider.models ?? [])],
  }))
  let bounded: RuntimeReport = {
    ...report,
    roots,
    repos,
    ...(report.agents ? { agents } : {}),
    ...(report.project_runtime ? { project_runtime: { ...report.project_runtime, providers } } : {}),
  }
  const tooLarge = () => Buffer.byteLength(JSON.stringify(bounded, null, 1)) > 64 * 1024
  if (!tooLarge()) return bounded
  bounded = { ...bounded, truncated: true }
  while (tooLarge() && repos.length) repos.pop()
  for (const agent of [...agents].reverse()) {
    while (tooLarge() && agent.models.length) {
      const index = agent.models.findLastIndex((model) => model.id !== agent.default_model)
      if (index < 0) break
      agent.models.splice(index, 1)
    }
  }
  for (const provider of [...providers].reverse()) {
    while (tooLarge() && provider.models.length) provider.models.pop()
  }
  while (tooLarge() && roots.length) roots.pop()
  if (tooLarge()) throw new Error('设备报告超出容量限制')
  return bounded
}
