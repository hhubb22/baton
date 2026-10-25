import { createConnection } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { StdioClient, frames, writeFrame } from '../../shared/stdio.js'
import { probe, runtimeModels, VERSION, registeredProvider, loginApiKey } from './auth.js'
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
export async function runProjectRuntimeCLI(args: string[]): Promise<void> {
  const [command, provider] = args
  if (command === '--version') {
    console.log(VERSION)
    return
  }
  if (command === 'probe') {
    console.log(JSON.stringify(await probe()))
    return
  }
  if (command === 'login-api-key') {
    const { provider: registration } = registeredProvider(provider)
    if (!registration.auth.apiKey?.login) throw new Error('api_key_unsupported')
    if (process.stdin.isTTY) throw new Error('api_key_stdin_required')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.length
      if (bytes > 16 * 1024) throw new Error('api_key_invalid')
      chunks.push(data)
    }
    await loginApiKey(provider, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    console.error('API key 已保存。')
    return
  }
  if (command === 'login-device') {
    if (!registeredProvider(provider).deviceCode) throw new Error('device_code_unsupported')
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
    if (!registeredProvider(provider).provider.auth.oauth) throw new Error('oauth_unsupported')
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
    throw new Error(
      'usage: baton-project-runtime run|probe|login <provider>|login-device <provider>|login-api-key <provider> < key-file|--version',
    )
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      'max-output-tokens': { type: 'string' },
      'max-model-calls': { type: 'string' },
    },
  })
  const budget = {
    ...(values['max-output-tokens'] === undefined ? {} : { maxOutputTokens: Number(values['max-output-tokens']) }),
    ...(values['max-model-calls'] === undefined ? {} : { maxModelCalls: Number(values['max-model-calls']) }),
  }
  const models = await runtimeModels()
  const { ProjectRuntime } = await import('./runtime.js')
  if (process.env.BATON_SIDECAR_TRANSPORT === 'stdio') {
    const client = new StdioClient(process.stdin, process.stdout)
    await new ProjectRuntime(
      checkedRPC((request) => client.call(request)),
      models,
      undefined,
      undefined,
      budget,
    ).start()
    process.stdin.destroy()
  } else await new ProjectRuntime(checkedRPC(ipc), models, undefined, undefined, budget).start()
}

export function reportProjectRuntimeError(error: unknown): void {
  const messages: Record<string, string> = {
    unsupported_provider: '该 provider 未注册，请运行 probe 查看已实现的 provider。',
    api_key_unsupported: '该 provider 不支持 API key，请使用订阅登录。',
    api_key_stdin_required: '从标准输入读取 API key：login-api-key <provider> < 私有密钥文件。',
    api_key_invalid: 'API key 不能为空，须为单行文本且不超过 16 KiB。',
    device_code_unsupported: '该 provider 支持终端登录，请使用 login <provider>。',
  }
  console.error(
    (error instanceof Error ? messages[error.message] : undefined) ??
      'Project Runtime 执行失败，请检查版本、登录状态和节点连接。',
  )
  process.exitCode = 1
  process.stdin.destroy()
}
