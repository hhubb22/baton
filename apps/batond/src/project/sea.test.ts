import { expect, it, vi } from 'vite-plus/test'
import { currentBatondCommand } from '../daemon/host.ts'
import { runBatondCLI } from '../cli.ts'
import { defaultRuntimeCommand, defaultWatchdogCommand } from './runner.ts'

vi.mock('node:sea', () => ({ isSea: () => true }))

it('starts packaged processes through the executable without a source entry or Node loader', () => {
  const command = currentBatondCommand()
  expect(command).toEqual({ executable: process.execPath, args: [] })
  expect(defaultWatchdogCommand()).toEqual({ file: command.executable, args: ['watchdog'] })
  const runtime = defaultRuntimeCommand()
  expect(runtime.file).toBe(command.executable)
  expect(runtime.args).toEqual(['project-runtime'])
})

it('reports the embedded Node and dispatches Runtime arguments independently of process argv', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await runBatondCLI(['--version'])
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      sea: true,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    })
    output.mockClear()
    await runBatondCLI(['project-runtime', '--version'])
    expect(output).toHaveBeenCalledWith('0.1.0')
  } finally {
    output.mockRestore()
  }
})
