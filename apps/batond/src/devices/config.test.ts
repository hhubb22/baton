import { realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeReport } from '@baton/protocol'
import { Schema } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import {
  boundRuntimeReport,
  makeDeviceService,
  parseThreadAttachments,
  readProjectExec,
  readProjectRuntimeConfig,
  runDeviceCLI,
  updateBrowseRoots,
} from './index.ts'
import { openAuthorized } from './files.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

const temporary: string[] = []
async function directory(): Promise<string> {
  const path = await realpath(await makePrivateTempDirectory('baton-device-config-'))
  temporary.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('preserves files and project-exec CLI flags and displays the risk before enabling', async () => {
  const data = await directory(),
    root = await directory(),
    lines: string[] = []
  const output = (text: string) => {
    lines.push(text)
  }
  await runDeviceCLI('files', ['add', '--id', 'dev', '--path', root, '--data-dir', data], data, output)
  await runDeviceCLI('files', ['list'], data, output)
  expect(lines).toContain(`dev\t${root}`)
  await expect(runDeviceCLI('project-exec', ['--shell', '/bin/sh', '--data-dir', data], data, output)).rejects.toThrow(
    '必须显式指定',
  )
  await runDeviceCLI('project-exec', ['--enabled=true', '--shell', '/bin/sh', '--data-dir', data], data, output)
  expect(lines.at(-2)).toMatch(/任意命令.*当前|任意命令.*本设备用户/)
  expect(lines.at(-1)).toContain('true')
  expect(await readProjectExec(data)).toMatchObject({ enabled: true, shell: '/bin/sh' })
  await runDeviceCLI('project-exec', ['--enabled=false'], data, output)
  expect(await readProjectExec(data)).toMatchObject({ enabled: false })
  await runDeviceCLI('files', ['remove', '--id', 'dev', '--data-dir', data], data, output)
  expect(await updateBrowseRoots(data, { action: 'remove', path: 'dev' })).toEqual([])
})

it('loads practical Project defaults and validates configured model budgets', async () => {
  const data = await directory()
  expect(await readProjectRuntimeConfig(data)).toEqual({
    maxConcurrentProjects: 4,
    probeTimeoutMs: 5000,
    probeMaxOutputBytes: 64 * 1024,
    maxOutputTokens: 32000,
    maxModelCalls: 64,
  })
  const config = {
    maxConcurrentProjects: 6,
    probeTimeoutMs: 15000,
    probeMaxOutputBytes: 128 * 1024,
    maxOutputTokens: 48000,
    maxModelCalls: 128,
  }
  await writeFile(join(data, 'project-runtime.json'), JSON.stringify(config), { mode: 0o600 })
  expect(await readProjectRuntimeConfig(data)).toEqual(config)
  await writeFile(join(data, 'project-runtime.json'), JSON.stringify({ maxModelCalls: Number.MAX_SAFE_INTEGER + 1 }))
  await expect(readProjectRuntimeConfig(data)).rejects.toThrow('配置无效')
})

it('uses the Runtime report path so probe budgets and cached diagnostics survive collection', async () => {
  const data = await directory()
  const service = await makeDeviceService({
    dataDirectory: data,
    runtime: {
      probe: async () => {
        throw new Error('直接 probe 不保留报告缓存')
      },
      report: async (signal) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2100))
        signal?.throwIfAborted()
        return {
          version: '0.1.0',
          providers: [],
          probed_at: '2026-01-01T00:00:00Z',
          stale: true,
          probe_error: 'probe_timeout',
        }
      },
      startDeviceLogin: async () => {
        throw new Error('unused')
      },
    },
  })
  try {
    expect(await service.collect()).toMatchObject({ project_runtime: { stale: true, probe_error: 'probe_timeout' } })
  } finally {
    await service.close()
  }
})

it('bounds the combined runtime report, preserves default models and leaves its input intact', () => {
  const models = Array.from({ length: 64 }, (_, i) => ({ id: `model-${i}`, name: 'n'.repeat(500) }))
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: Array.from({ length: 32 }, (_, i) => ({
      root_id: `root-${i}`,
      path: `/workspace/${i}/` + 'p'.repeat(4000),
    })),
    repos: Array.from({ length: 128 }, (_, i) => ({ path: `/workspace/${i}/` + 'p'.repeat(4000) })),
    agents: [
      {
        agent_type: 'cursor',
        version: '1.0.35',
        status: 'available',
        models,
        default_model: 'model-0',
        capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
      },
    ],
  }
  const bounded = boundRuntimeReport(report)
  expect(Buffer.byteLength(JSON.stringify(bounded, null, 1))).toBeLessThanOrEqual(64 * 1024)
  expect(bounded.truncated).toBe(true)
  expect(bounded.agents?.[0]?.models).toContainEqual(models[0])
  expect(report.repos).toHaveLength(128)
  expect(report.agents?.[0]?.models).toHaveLength(64)
  expect(() => Schema.decodeUnknownSync(RuntimeReport)(bounded)).not.toThrow()
})

it('fails closed in reports when the local exec configuration is malformed', async () => {
  const data = await directory(),
    root = await directory()
  await updateBrowseRoots(data, { action: 'add', path: root })
  await writeFile(join(data, 'project-exec.json'), '{"enabled":true}', { mode: 0o600 })
  const service = await makeDeviceService({ dataDirectory: data })
  try {
    expect(await service.collect()).toMatchObject({ exec: { enabled: false }, truncated: true })
  } finally {
    await service.close()
  }
})

it('rejects reparenting after a file was opened and authorizes file and commit attachment references', async () => {
  const data = await directory(),
    root = await directory()
  await ensurePrivateDirectory(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'log.txt'), 'attachment')
  await ensurePrivateDirectory(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), '[remote "origin"]\nurl = git@git.example:team/repo.git\n')
  const [registered] = await updateBrowseRoots(data, { action: 'add', path: root })
  const sha = 'a'.repeat(40)
  const refs = await parseThreadAttachments(
    data,
    'node-id',
    root,
    `See nested/log.txt and /outside/log.txt and commit ${sha}`,
  )
  expect(refs).toEqual([
    { kind: 'file', node_id: 'node-id', root_id: registered!.id, path: 'nested/log.txt', access_status: 'available' },
    { kind: 'commit', repo: 'git.example/team/repo', sha },
  ])
  // Windows 不允许重命名仍被打开句柄占用的目录（EPERM），无法构造“打开后重挂父目录”的场景。
  if (process.platform !== 'win32') {
    const opened = await openAuthorized(registered!, 'nested/log.txt')
    try {
      await rename(join(root, 'nested'), join(root, 'moved'))
      await ensurePrivateDirectory(join(root, 'nested'))
      await writeFile(join(root, 'nested', 'log.txt'), 'replacement')
      await expect(opened.verify()).rejects.toThrow('路径超出')
    } finally {
      await opened.handle.close()
    }
  }
})
