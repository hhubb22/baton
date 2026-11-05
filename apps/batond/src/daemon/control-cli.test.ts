import { expect, it, vi } from 'vite-plus/test'
import { runControlCLI } from './control-cli.ts'
import type { ControlRequest, ControlResponse } from './control.ts'

it('opens the complete verification URL and waits for online status', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const openBrowser = vi.fn(async () => undefined)
  const requests: ControlRequest[] = []
  const replies: ControlResponse[] = [
    {
      ok: true,
      status: 'pending',
      verification_uri_complete: 'https://center.invalid/device-login?code=ABCD-EFGH',
      user_code: 'ABCD-EFGH',
    },
    { ok: true, state: 'connecting' },
    { ok: true, state: 'online' },
  ]
  try {
    await runControlCLI('login', ['--coordinator', 'https://center.invalid', '--display-name', 'xai'], {
      client: {
        request: async (request) => {
          requests.push(request)
          return replies.shift()!
        },
      },
      openBrowser,
      waitIntervalMs: 1,
    })
    expect(requests[0]).toEqual({
      method: 'login_start',
      coordinator_url: 'https://center.invalid',
      display_name: 'xai',
    })
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('https://center.invalid/device-login?code=ABCD-EFGH')
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).state).toBe('online')
  } finally {
    output.mockRestore()
  }
})

it('exits CLI waiting on cancellation without cancelling the daemon login', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const controller = new AbortController()
  const requests: ControlRequest[] = []
  try {
    await runControlCLI('login', ['--coordinator', 'https://center.invalid'], {
      signal: controller.signal,
      client: {
        request: async (request) => {
          requests.push(request)
          if (request.method === 'status') controller.abort()
          return { ok: true, state: 'authorizing' }
        },
      },
    })
    expect(requests.map((request) => request.method)).toEqual(['login_start', 'status'])
  } finally {
    output.mockRestore()
  }
})

it('explicit cancellation only sends login_cancel and prints its result', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const request = vi.fn(async (): Promise<ControlResponse> => ({ ok: true }))
  try {
    await runControlCLI('login', ['--cancel'], { client: { request } })
    expect(request).toHaveBeenCalledExactlyOnceWith({ method: 'login_cancel' })
  } finally {
    output.mockRestore()
  }
})
