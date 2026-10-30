import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { expect, it } from 'vite-plus/test'
import { applyEnvironment, baseEnvironment, resolveEnvironment, updateEnvironment } from './environment.ts'
import { RuntimeRunner } from './project/runner.ts'
import { makePrivateTempDirectory } from './testing/private.ts'

const script = `process.stdout.write(JSON.stringify({
  device: process.env.ENV_TEST_DEVICE,
  project: process.env.ENV_TEST_PROJECT,
  agent: process.env.ENV_TEST_AGENT,
  combined: process.env.ENV_TEST_COMBINED,
  old: process.env.ENV_TEST_OLD,
  removed: process.env.ENV_TEST_REMOVED,
  parentSecret: process.env.PARENT_SECRET_FOR_TEST
}))`

it('passes scoped environment to real child processes and removes stale parent values', async () => {
  const directory = await makePrivateTempDirectory('baton-env-process-')
  const saved = { ...process.env }
  const project = '3f53c441-a0b9-4d70-b676-369f01bd8683'
  const runner = new RuntimeRunner(
    { dataDir: directory, runtimeCommand: { file: process.execPath, args: ['-e', script] } },
    process.platform === 'win32'
      ? undefined
      : { pid: process.pid, register: async () => {}, unregister: async () => {}, close: async () => {} },
    { add: async () => {}, remove: async () => {} },
  )
  try {
    const config = await updateEnvironment(directory, (current) => ({
      ...current,
      scopes: {
        device: {
          ENV_TEST_DEVICE: 'device',
          ENV_TEST_PROJECT: 'device',
          ENV_TEST_AGENT: 'device',
          ENV_TEST_COMBINED: 'device',
          ENV_TEST_OLD: 'old',
          ENV_TEST_REMOVED: 'old',
        },
        [`project:${project}`]: { ENV_TEST_PROJECT: 'project', ENV_TEST_COMBINED: 'project' },
        'agent:pi': { ENV_TEST_AGENT: 'agent', ENV_TEST_COMBINED: 'agent' },
        [`project:${project}:agent:pi`]: { ENV_TEST_COMBINED: 'combined' },
      },
    }))
    const inherited = applyEnvironment(config, { ...process.env, PARENT_SECRET_FOR_TEST: 'private' })
    Object.assign(process.env, inherited, { BATON_ENV_DATA_DIR: directory })
    const run = async () => {
      let output = ''
      let ended: Promise<void> | undefined
      const owned = await runner.spawn(
        ['run'],
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        (child) => {
          ended = new Promise((resolve) => child.stdout.once('end', resolve))
          child.stdout.on('data', (chunk) => {
            output += String(chunk)
          })
        },
        project,
      )
      await ended
      await runner.reap(owned)
      return JSON.parse(output) as Record<string, string>
    }
    expect(await run()).toEqual({
      device: 'device',
      project: 'project',
      agent: 'device',
      combined: 'project',
      old: 'old',
      removed: 'old',
    })
    const agentEnv = resolveEnvironment(config, baseEnvironment(process.env), { project, agent: 'pi' }).env
    const child = spawn(process.execPath, ['-e', script], { env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let agentOutput = ''
    for await (const chunk of child.stdout) agentOutput += String(chunk)
    expect(JSON.parse(agentOutput)).toEqual({
      device: 'device',
      project: 'project',
      agent: 'agent',
      combined: 'combined',
      old: 'old',
      removed: 'old',
    })
    await updateEnvironment(directory, (current) => {
      const device = { ...current.scopes.device }
      delete device.ENV_TEST_OLD
      device.ENV_TEST_REMOVED = null
      return { ...current, scopes: { ...current.scopes, device } }
    })
    expect(await run()).toEqual({ device: 'device', project: 'project', agent: 'device', combined: 'project' })
  } finally {
    await runner.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
