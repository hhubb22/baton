import { jsonBytes, type RuntimeReport } from '@baton/protocol'

/** 按报告 Schema 的缩进和字符转义计量，先裁仓库，再裁模型，最后裁目录。 */
export function boundRuntimeReport(report: RuntimeReport, maxBytes = 64 * 1024): RuntimeReport {
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
  const tooLarge = () => jsonBytes(bounded, 1, true) > maxBytes
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
    while (tooLarge() && provider.models.length) {
      provider.models.pop()
      Object.assign(provider, { models_truncated: true })
    }
  }
  while (tooLarge() && roots.length) roots.pop()
  if (tooLarge()) throw new Error('设备报告超出容量限制')
  return bounded
}
