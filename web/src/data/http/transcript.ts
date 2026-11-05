import type { ProjectRunSummary, TranscriptPage } from '@baton/protocol'
import { apiPath, type HttpContext } from './context'

export function createTranscriptAPI(ctx: HttpContext) {
  return {
    readThreadTranscript(threadId: string, offset?: number): Promise<TranscriptPage> {
      const query = new URLSearchParams()
      if (offset !== undefined) query.set('offset', String(offset))
      return ctx.request<TranscriptPage>(`/threads/${apiPath(threadId)}/transcript${query.size ? `?${query}` : ''}`)
    },
    listProjectRuns(projectId: string, limit = 50): Promise<ProjectRunSummary[]> {
      return ctx
        .request<{ runs: ProjectRunSummary[] }>(`/projects/${apiPath(projectId)}/runs?limit=${limit}`)
        .then((result) => result.runs)
    },
    readProjectRunTranscript(projectId: string, runId: string, offset?: number): Promise<TranscriptPage> {
      const query = new URLSearchParams()
      if (offset !== undefined) query.set('offset', String(offset))
      return ctx.request<TranscriptPage>(
        `/projects/${apiPath(projectId)}/runs/${apiPath(runId)}/transcript${query.size ? `?${query}` : ''}`,
      )
    },
  }
}
