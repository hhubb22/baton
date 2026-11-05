import { describe, expect, it, vi } from 'vite-plus/test'
import type { HttpContext } from './context'
import { createTranscriptAPI } from './transcript'

const page = {
  offset: 0,
  next_offset: 8,
  total_bytes: 8,
  expires_at: '2099-01-01T00:00:00.000Z',
  encoding: 'base64' as const,
  data: 'eyJzZXEiOjF9Cg==',
  done: true,
  incomplete_tail: false,
}

const setup = () => {
  const request = vi.fn<(path: string) => Promise<unknown>>()
  return { api: createTranscriptAPI({ request } as unknown as HttpContext), request }
}

describe('transcript API', () => {
  it('pages through a thread transcript by byte offset', async () => {
    const { api, request } = setup()
    request.mockResolvedValue(page)
    expect(await api.readThreadTranscript('thread', 8192)).toEqual(page)
    expect(request).toHaveBeenCalledWith('/threads/thread/transcript?offset=8192')
    await api.readThreadTranscript('thread')
    expect(request).toHaveBeenLastCalledWith('/threads/thread/transcript')
  })

  it('lists project runs and reads one run transcript', async () => {
    const { api, request } = setup()
    request.mockResolvedValueOnce({ runs: [] })
    expect(await api.listProjectRuns('project', 20)).toEqual([])
    expect(request).toHaveBeenLastCalledWith('/projects/project/runs?limit=20')
    request.mockResolvedValueOnce(page)
    expect(await api.readProjectRunTranscript('project', 'run', 0)).toEqual(page)
    expect(request).toHaveBeenLastCalledWith('/projects/project/runs/run/transcript?offset=0')
  })
})
