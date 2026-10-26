import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProcessWatchdog, type ProcessWatchdog } from '../platform/process.ts'
import { validatePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { RuntimeRunner, defaultWatchdogCommand } from './runner.ts'
import type { ProjectManagerOptions } from './types.ts'

export async function runProjectCLI(
  command: 'probe' | 'subscriptions' | 'login',
  provider?: string,
  options: Pick<ProjectManagerOptions, 'runtimeCommand' | 'watchdogCommand'> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'baton-project-cli-'))
  let watchdog: ProcessWatchdog | undefined
  let runner: RuntimeRunner | undefined
  const cancel = new AbortController()
  const abort = () => cancel.abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    await validatePrivateDirectory(directory)
    watchdog =
      process.platform === 'win32'
        ? undefined
        : await startProcessWatchdog(options.watchdogCommand ?? defaultWatchdogCommand())
    runner = new RuntimeRunner({ ...options, dataDir: directory }, watchdog, {
      add: async (record) => {
        await writePrivateFileAtomic(join(directory, `${record.pid}.json`), JSON.stringify(record))
      },
      remove: async (record) => {
        await rm(join(directory, `${record.pid}.json`), { force: true })
      },
    })
    if (command === 'login') {
      if (!provider) throw new Error('请指定模型订阅服务：openai-codex 或 xai')
      await runner.login(provider, cancel.signal)
    } else {
      const report = await runner.probe(cancel.signal)
      if (command === 'probe') process.stdout.write(JSON.stringify(report) + '\n')
      else
        for (const item of report.providers ?? []) {
          const state = { available: '已登录', login_required: '需要登录', unknown: '无法读取' }[item.status]
          process.stdout.write(
            `${item.provider}: ${state}${item.status === 'available' ? '' : `，运行 batond login ${item.provider}`}\n`,
          )
        }
    }
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
    try {
      await runner?.close()
    } finally {
      await watchdog?.close()
    }
    await rm(directory, { recursive: true, force: true })
  }
}
