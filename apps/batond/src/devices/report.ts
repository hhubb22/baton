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
  const trim = <A>(items: A[], protectedItem: (item: A) => boolean = () => false) => {
    if (!items.length || !tooLarge()) return
    const original = [...items]
    let low = 0
    let high = original.filter((item) => !protectedItem(item)).length
    const retain = (count: number) => {
      let removable = 0
      items.length = 0
      for (const item of original) {
        if (protectedItem(item) || removable++ < count) items.push(item)
      }
    }
    retain(0)
    if (tooLarge()) return
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      retain(middle)
      if (tooLarge()) high = middle - 1
      else low = middle
    }
    retain(low)
  }
  trim(repos)
  for (const agent of [...agents].reverse()) {
    trim(agent.models, (model) => model.id === agent.default_model)
  }
  for (const provider of [...providers].reverse()) {
    if (tooLarge() && provider.models.length) {
      Object.assign(provider, { models_truncated: true })
      trim(provider.models)
    }
  }
  trim(roots)
  if (tooLarge()) throw new Error('设备报告超出容量限制')
  return bounded
}
