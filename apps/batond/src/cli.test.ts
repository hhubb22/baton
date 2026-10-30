import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vite-plus/test'
import type { RuntimeAgent, WorkerIPCMessage, WorkerRequest } from '@baton/protocol'
import { reportBatondError, runBatondCLI, runLocalCLI } from './cli.ts'
import { manageService, ServiceError } from './daemon/service.ts'
import { runDaemonCLI } from './daemon/cli.ts'
import { makePrivateTempDirectory } from './testing/private.ts'

vi.mock('./daemon/cli.ts', () => ({ runDaemonCLI: vi.fn() }))
vi.mock('./daemon/service.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daemon/service.ts')>()),
  manageService: vi.fn(async () => ({ installed: true })),
}))

it.each(['install', 'uninstall', 'status'])('routes service %s and prints its result', async (action) => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runBatondCLI(['service', action, '--data-dir', '/offline-node'])
    expect(manageService).toHaveBeenLastCalledWith(action, '/offline-node')
    expect(output).toHaveBeenCalledWith(JSON.stringify({ installed: true }))
  } finally {
    output.mockRestore()
  }
})

it.each([{ args: [] }, { args: ['restart'] }, { args: ['install', 'status'] }])(
  'rejects invalid service arguments %j',
  async ({ args }) => {
    await expect(runBatondCLI(['service', ...args])).rejects.toThrow('用法：service')
  },
)

it('preserves service error codes in CLI errors', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const previous = process.exitCode
  try {
    reportBatondError(new ServiceError('service_unsupported', 'Windows 请使用 Baton 桌面客户端'), 'service')
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, code: 'service_unsupported', message: 'Windows 请使用 Baton 桌面客户端' }),
    )
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previous
    output.mockRestore()
  }
})

it('routes reauth to the node CLI and documents it in help', async () => {
  const args = ['--data-dir', '/offline-node', '--enrollment-file', '/private/enrollment']
  await runBatondCLI(['reauth', ...args])
  expect(runDaemonCLI).toHaveBeenCalledWith('reauth', args)
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runBatondCLI(['--help'])
    expect(output).toHaveBeenCalledWith(expect.stringContaining('reauth [--enrollment-file'))
  } finally {
    output.mockRestore()
  }
})

it('opens each local Agent with a custom model and budget and reuses its saved configuration', async () => {
  const directory = await makePrivateTempDirectory('baton-cli-')
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    const cwd = await realpath(directory)
    const requests: WorkerRequest[] = []
    const probeAgent = async (agent: 'cursor' | 'pi' | 'codex' | 'kiro'): Promise<RuntimeAgent> => ({
      agent_type: agent,
      version: 'offline',
      status: 'available',
      default_model: 'default',
      runtime_modes: [
        { id: 'full-access', available: true },
        { id: 'approval-required', available: true },
      ],
      default_runtime_mode: 'full-access',
      models: [],
      capabilities: {
        create: true,
        queue: true,
        steer: agent === 'pi' || agent === 'codex',
        stop: true,
        resume: true,
        switch_model: false,
      },
    })
    const dependencies = {
      probeAgent,
      host: {
        request: async (_id: string, request: WorkerRequest): Promise<WorkerIPCMessage> => {
          requests.push(request)
          return { type: 'result', ok: true }
        },
      },
    }
    for (const agent of ['cursor', 'pi', 'codex', 'kiro']) {
      const thread = randomUUID()
      const base = ['--data-dir', directory, '--thread-id', thread]
      await runLocalCLI(
        [
          'open',
          ...base,
          '--cwd',
          cwd,
          '--agent',
          agent,
          '--model',
          'custom-id',
          '--runtime-mode',
          'approval-required',
          '--execution-timeout-seconds',
          '14400',
        ],
        dependencies,
      )
      await runLocalCLI(['open', ...base], dependencies)
      const original = requests.at(-2)
      expect(original?.open_config).toMatchObject({
        agent_type: agent,
        runtime_mode: 'approval-required',
        model: 'custom-id',
        execution_timeout_seconds: 14400,
        working_directory: cwd,
      })
      expect(requests.at(-1)).toEqual(original)
      await expect(runLocalCLI(['open', ...base, '--execution-timeout-seconds', '10'], dependencies)).rejects.toThrow(
        'Thread 已有不同的新建配置',
      )
    }
  } finally {
    output.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

it('sends a steer message and rejects a model change with steer before handing it to the Worker', async () => {
  const directory = await makePrivateTempDirectory('baton-cli-steer-')
  const requests: WorkerRequest[] = []
  const thread = randomUUID()
  const generation = randomUUID()
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const dependencies = {
    host: {
      request: async (_id: string, request: WorkerRequest): Promise<WorkerIPCMessage> => {
        requests.push(request)
        return { type: 'result', ok: true, storage_generation: generation }
      },
    },
  }
  try {
    const args = ['message', '--data-dir', directory, '--thread-id', thread, '--text', 'check tests', '--mode', 'steer']
    await runLocalCLI(args, dependencies)
    expect(requests.at(-1)).toMatchObject({
      type: 'thread_message',
      mode: 'steer',
      payload: 'check tests',
      storage_generation: generation,
    })
    requests.length = 0
    await expect(runLocalCLI([...args, '--model', 'custom'], dependencies)).rejects.toThrow('插入消息不能更换模型')
    expect(requests).toEqual([])
    await expect(runLocalCLI(['open', '--execution-timeout-seconds', '0'], dependencies)).rejects.toThrow()
    await expect(runLocalCLI(['open', '--execution-timeout-seconds', '2147483648'], dependencies)).rejects.toThrow()
    expect(requests).toEqual([])
  } finally {
    output.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
