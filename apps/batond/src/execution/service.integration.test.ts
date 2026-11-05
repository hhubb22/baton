import { randomUUID } from 'node:crypto'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutionCommand } from '@baton/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { startProcessWatchdog, type ProcessWatchdog } from '../platform/process.ts'
import { makeExecutionService } from './service.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

async function fixture() {
  const root = await makePrivateTempDirectory('baton-exec-service-')
  const cwd = join(root, 'work')
  await ensurePrivateDirectory(cwd)
  await writePrivateFileAtomic(join(root, 'browse-roots.json'), JSON.stringify({ roots: [{ id: 'work', path: cwd }] }))
  await writePrivateFileAtomic(join(root, 'project-exec.json'), JSON.stringify({ enabled: true, shell: '/bin/sh' }))
  const watchdog: ProcessWatchdog = await startProcessWatchdog({
    file: process.execPath,
    args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
  })
  cleanup.push(async () => {
    await watchdog.close()
    await rm(root, { recursive: true, force: true })
  })
  const service = makeExecutionService({ dataDirectory: root, watchdog })
  cleanup.push(() => service.close())
  return { root, cwd, watchdog, service }
}

const start = (executionId: string, command: string, timeout = 10): ExecutionCommand => ({
  type: 'execution.command',
  action: 'start',
  execution_id: executionId,
  storage_generation: randomUUID(),
  command,
  working_directory: '',
  timeout_seconds: timeout,
  project_id: randomUUID(),
})

async function poll(service: ReturnType<typeof makeExecutionService>, executionId: string) {
  return expect
    .poll(
      async () => {
        const reports = await service.collectReports()
        return reports.some(
          (report) => report.execution_id === executionId && !['pending', 'running'].includes(report.status),
        )
      },
      { timeout: 8000 },
    )
    .toBe(true)
}

const reportOf = async (service: ReturnType<typeof makeExecutionService>, executionId: string) => {
  const reports = (await service.collectReports()).filter((report) => report.execution_id === executionId)
  return reports.find((report) => !['pending', 'running'].includes(report.status)) ?? reports.at(-1)!
}

it.runIf(process.platform !== 'win32')(
  'runs each submitted command once, retains output and pages it after completion',
  async () => {
    const f = await fixture()
    const id = randomUUID()
    const command = { ...start(id, 'printf hello'), working_directory: f.cwd }
    expect(await f.service.command(command)).toMatchObject({ ok: true })
    expect(await f.service.command(command)).toMatchObject({ ok: true })
    await poll(f.service, id)
    const report = await reportOf(f.service, id)
    expect(report.status).toBe('completed')
    expect(report).toMatchObject({
      output: 'hello',
      exit_code: 0,
      total_bytes: 5,
      full_output: { total_bytes: 5 },
    })
    const page = await f.service.output({
      type: 'execution.output_request',
      operation_id: randomUUID(),
      execution_id: id,
      output_id: report.full_output!.id,
      storage_generation: report.storage_generation,
    })
    expect(page).toMatchObject({ ok: true })
    expect(Buffer.from(page.full_output!.data, 'base64').toString('utf8')).toBe('hello')
    for (const item of (await f.service.collectReports()).filter((entry) => entry.execution_id === id))
      await f.service.ack({
        type: 'execution.report_result',
        execution_id: id,
        event_id: item.event_id,
        seq: item.seq,
        ok: true,
      })
    expect(await f.service.collectReports()).toEqual([])
  },
  20000,
)

it.runIf(process.platform !== 'win32')(
  'persists completion before ACK and reloads it without executing again',
  async () => {
    const f = await fixture()
    const id = randomUUID()
    const marker = join(f.root, 'marker')
    const command = { ...start(id, `printf once >> ${marker}`), working_directory: f.cwd }
    expect(await f.service.command(command)).toMatchObject({ ok: true })
    await poll(f.service, id)
    const first = await reportOf(f.service, id)
    expect(first.status).toBe('completed')
    await f.service.close()

    const restarted = makeExecutionService({ dataDirectory: f.root, watchdog: f.watchdog })
    cleanup.push(() => restarted.close())
    await restarted.recover()
    const report = await reportOf(restarted, id)
    expect(report).toMatchObject({ status: 'completed', event_id: first.event_id, seq: first.seq })
    expect(await readFile(marker, 'utf8')).toBe('once')
  },
  20000,
)

it.runIf(process.platform !== 'win32')(
  'persists stop before start and never spawns a cancelled command',
  async () => {
    const f = await fixture()
    const id = randomUUID()
    const generation = randomUUID()
    expect(
      await f.service.command({
        type: 'execution.command',
        action: 'stop',
        execution_id: id,
        storage_generation: generation,
      }),
    ).toMatchObject({ ok: true })
    const command: ExecutionCommand = {
      ...start(id, 'printf forbidden > forbidden'),
      storage_generation: generation,
      working_directory: f.cwd,
    }
    expect(await f.service.command(command)).toMatchObject({ ok: true })
    await poll(f.service, id)
    expect(await reportOf(f.service, id)).toMatchObject({ status: 'cancelled' })
    await expect(readFile(join(f.cwd, 'forbidden'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  },
  20000,
)

it.runIf(process.platform !== 'win32')(
  'times out a running command through the managed process tree',
  async () => {
    const f = await fixture()
    const id = randomUUID()
    const command = { ...start(id, 'sleep 30', 1), working_directory: f.cwd }
    expect(await f.service.command(command)).toMatchObject({ ok: true })
    await poll(f.service, id)
    expect(await reportOf(f.service, id)).toMatchObject({ status: 'timed_out' })
  },
  20000,
)

it.runIf(process.platform !== 'win32')(
  'rejects commands outside authorized roots and conflicting resubmissions',
  async () => {
    const f = await fixture()
    const id = randomUUID()
    const outside = join(f.root, 'outside')
    await ensurePrivateDirectory(outside)
    const rejected = { ...start(id, 'printf no'), working_directory: outside }
    expect(await f.service.command(rejected)).toMatchObject({ ok: false, code: 'execution_not_authorized' })
    const accepted = { ...start(randomUUID(), 'printf yes'), working_directory: f.cwd }
    expect(await f.service.command(accepted)).toMatchObject({ ok: true })
    expect(await f.service.command({ ...accepted, command: 'printf other' })).toMatchObject({
      ok: false,
      code: 'command_conflict',
    })
    await appendFile(join(f.cwd, '.keep'), '')
  },
  20000,
)
