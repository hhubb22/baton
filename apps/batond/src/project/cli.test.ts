import { expect, it, vi } from 'vite-plus/test'
import { runProjectCLI } from './cli.ts'

it('probes through a CLI-owned private directory and process record', async () => {
  const report = { version: '0.1.0', providers: [{ provider: 'openai-codex', status: 'login_required' }] }
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await runProjectCLI('probe', undefined, {
      runtimeCommand: {
        file: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(JSON.stringify(report))})`],
      },
    })
    expect(JSON.parse(output.mock.calls.map(([bytes]) => String(bytes)).join(''))).toMatchObject(report)
  } finally {
    output.mockRestore()
  }
})
