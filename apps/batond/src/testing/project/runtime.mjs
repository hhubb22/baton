import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [mode, command] = process.argv.slice(2)
if (command === 'probe') {
  if (mode === 'bad-probe') console.log('{"version":"development","providers":null}')
  else
    console.log(
      JSON.stringify({
        version: '0.1.0',
        memory_protocol: 1,
        providers: [{ provider: 'openai-codex', status: mode === 'memory-idle' ? 'login_required' : 'available' }],
      }),
    )
} else if (command === 'login-device') {
  console.log(
    JSON.stringify({
      type: 'device_code',
      provider: process.argv.at(-1),
      verification_uri: 'https://login.invalid/device',
      user_code: 'LOCAL-CODE',
      expires_in_seconds: 900,
    }),
  )
  process.stdin.resume()
  process.stdin.on('end', () => process.exit())
  setInterval(() => {}, 1000)
} else if (command === 'run' || command === 'memory') {
  if (mode === 'real-runtime') {
    await import('@baton/project-agent-runtime/testing/integration-worker')
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
    const call = (request) =>
      new Promise((resolve) => {
        pending.set(++id, resolve)
        process.stdout.write(JSON.stringify({ id, request }) + '\n')
      })
    if (mode === 'exercise') {
      const denied = await call({ operation: 'renew' })
      const boot = await call({
        operation: 'bootstrap',
        run_id: 'forged',
        lease_epoch: 999,
        payload: { pid: process.pid, branch: branch.pid, denied },
      })
      await call({
        operation: 'embedding_query',
        run_id: 'forged',
        lease_epoch: 999,
        last_seq: 0,
        payload: { input_seq: 0, query: 'technical query' },
      })
      await call({
        operation: 'prepare_context',
        run_id: 'forged',
        lease_epoch: 999,
        last_seq: 0,
        payload: {
          context_id: 'local-context',
          input_seq: 0,
          core_tokens: 1500,
          related_tokens: 3500,
          max_bytes: 40960,
        },
      })
      const pending = await call({
        operation: 'call_tool',
        tool_call_id: 'exec-1',
        tool_name: 'nodes.exec',
        arguments: {},
        last_seq: 1,
      })
      const changed = await call({
        operation: 'poll_wake',
        payload: { thread_id: pending.data.thread_id, after_version: pending.data.version, wait_ms: 25000 },
      })
      await call({ operation: 'wait_tool', tool_call_id: 'exec-1', payload: { changed, boot }, last_seq: 1 })
      const unbound = await call({
        operation: 'poll_wake',
        payload: { thread_id: pending.data.thread_id, after_version: pending.data.version, wait_ms: 1 },
      })
      await call({ operation: 'preview', payload: { unbound } })
      await call({ operation: 'finish' })
      process.exit()
    } else {
      await call({
        operation: command === 'memory' ? 'memory_bootstrap' : 'bootstrap',
        payload: { pid: process.pid, branch: branch.pid },
      })
      if (mode === 'upgrade-drain' && command === 'run') {
        await call({ operation: 'preview', payload: { saved: true } })
        await call({ operation: 'claim_inputs', last_seq: 0 })
        process.exit()
      }
      setInterval(() => {}, 1000)
    }
  }
}
