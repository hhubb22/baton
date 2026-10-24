import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [mode, command] = process.argv.slice(2)
if (command === 'probe') {
  if (mode === 'bad-probe') console.log('{"version":"0.0.1","providers":[]}')
  else console.log(JSON.stringify({ version: '0.1.0', providers: [{ provider: 'openai-codex', status: 'available' }] }))
} else if (command === 'login-device') {
  console.log(JSON.stringify({ type: 'device_code', provider: process.argv.at(-1), verification_uri: 'https://login.invalid/device', user_code: 'LOCAL-CODE', expires_in_seconds: 900 }))
  process.stdin.resume()
  process.stdin.on('end', () => process.exit())
  setInterval(() => {}, 1000)
} else if (command === 'run') {
  if (mode === 'real-runtime') {
    await import('../../../../../runtimes/project-agent/test/integration-worker.ts')
  } else {
    if (process.env.FIXTURE_LAUNCH_LOG) appendFileSync(process.env.FIXTURE_LAUNCH_LOG, `${process.pid}\n`)
    const branch = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    let id = 0
    const pending = new Map()
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const frame = JSON.parse(line)
      pending.get(frame.id)?.(frame.result)
      pending.delete(frame.id)
    })
    const call = (request) => new Promise((resolve) => {
      pending.set(++id, resolve)
      process.stdout.write(JSON.stringify({ id, request }) + '\n')
    })
    if (mode === 'exercise') {
      const denied = await call({ operation: 'renew' })
      const boot = await call({ operation: 'bootstrap', run_id: 'forged', lease_epoch: 999, payload: { pid: process.pid, branch: branch.pid, denied } })
      const pending = await call({ operation: 'call_tool', tool_call_id: 'exec-1', tool_name: 'nodes.exec', arguments: {}, last_seq: 1 })
      const changed = await call({ operation: 'poll_wake', payload: { thread_id: pending.data.thread_id, after_version: pending.data.version, wait_ms: 25000 } })
      await call({ operation: 'wait_tool', tool_call_id: 'exec-1', payload: { changed, boot }, last_seq: 1 })
      const unbound = await call({ operation: 'poll_wake', payload: { thread_id: pending.data.thread_id, after_version: pending.data.version, wait_ms: 1 } })
      await call({ operation: 'preview', payload: { unbound } })
      await call({ operation: 'finish' })
      process.exit()
    } else {
      await call({ operation: 'bootstrap', payload: { pid: process.pid, branch: branch.pid } })
      setInterval(() => {}, 1000)
    }
  }
}
