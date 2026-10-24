#!/usr/bin/env node
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { StdioClient, frames, writeFrame } from '../../shared/stdio.js'
import { probe, runtimeModels, VERSION, PROVIDERS } from './auth.js'
import { checkedRPC, type Request } from './protocol.js'
import { createDeviceCodeLoginInteraction, createLoginInteraction } from './login.js'

async function ipc(request: Request): Promise<unknown> {
  const endpoint = process.env.BATON_PROJECT_RUNTIME_ENDPOINT,
    token = process.env.BATON_PROJECT_RUNTIME_TOKEN
  if (!endpoint || !token) throw new Error('runtime_endpoint_missing')
  const socket = createConnection(endpoint)
  socket.setTimeout(32_000, () => socket.destroy(new Error('runtime_timeout')))
  try {
    await writeFrame(socket, { token, request })
    for await (const value of frames(socket)) return value
    throw new Error('runtime_closed')
  } finally {
    socket.destroy()
  }
}
async function main() {
  const [command, provider] = process.argv.slice(2)
  if (command === '--version') {
    console.log(VERSION)
    return
  }
  if (command === 'probe') {
    console.log(JSON.stringify(await probe()))
    return
  }
  if (command === 'login-device') {
    if (!PROVIDERS.includes(provider)) throw new Error('unsupported_provider')
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    process.on('SIGINT', abort)
    process.on('SIGTERM', abort)
    process.stdin.on('close', abort)
    process.stdin.resume()
    try {
      const models = await runtimeModels()
      await models.login(
        provider,
        'oauth',
        createDeviceCodeLoginInteraction((info) => {
          process.stdout.write(
            JSON.stringify({
              type: 'device_code',
              provider,
              verification_uri: info.verificationUri,
              user_code: info.userCode,
              expires_in_seconds: info.expiresInSeconds ?? 900,
            }) + '\n',
          )
        }, cancel.signal),
        { agentName: 'Baton Project Runtime' },
      )
    } finally {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
      process.stdin.off('close', abort)
      process.stdin.destroy()
    }
    return
  }
  if (command === 'login') {
    if (!PROVIDERS.includes(provider)) throw new Error('unsupported_provider')
    const models = await runtimeModels()
    const input = createInterface({
      input: process.stdin,
      output: process.stderr,
    })
    const cancel = new AbortController()
    input.on('SIGINT', () => cancel.abort())
    input.on('close', () => cancel.abort())
    try {
      await models.login(
        provider,
        'oauth',
        createLoginInteraction(
          (message, signal) => input.question(message, { signal }),
          (text) => {
            process.stderr.write(text)
          },
          cancel.signal,
        ),
        { agentName: 'Baton Project Runtime' },
      )
    } finally {
      input.close()
    }
    console.error('登录完成。')
    return
  }
  if (command !== 'run')
    throw new Error('usage: baton-project-runtime run|probe|login <provider>|login-device <provider>|--version')
  const models = await runtimeModels()
  const { ProjectRuntime } = await import('./runtime.js')
  if (process.env.BATON_SIDECAR_TRANSPORT === 'stdio') {
    const client = new StdioClient(process.stdin, process.stdout)
    await new ProjectRuntime(
      checkedRPC((request) => client.call(request)),
      models,
    ).start()
    process.stdin.destroy()
  } else await new ProjectRuntime(checkedRPC(ipc), models).start()
}
main().catch(() => {
  console.error('Project Runtime 执行失败，请检查版本、登录状态和节点连接。')
  process.exitCode = 1
  process.stdin.destroy()
})
