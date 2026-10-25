import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { privateFileHostCommand, tsxLoader } from './private-host.js'

const credentials = new URL('../src/credentials.ts', import.meta.url).href
function invoke(directory: string, script: string, host = privateFileHostCommand) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoader,
      '--input-type=module',
      '-e',
      `import { FileCredentials } from ${JSON.stringify(credentials)}; const store = new FileCredentials(${JSON.stringify(directory)}); ${script}`,
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        BATON_PRIVATE_FILE_HOST_COMMAND: JSON.stringify(host),
      },
      encoding: 'utf8',
      timeout: process.platform === 'win32' ? 120000 : 30000,
      maxBuffer: 64 * 1024,
    },
  )
}

test('显式 native host 不可用时拒绝凭据操作，不退回其他文件实现', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-native-host-'))
  try {
    const result = invoke(
      directory,
      `await store.modify('xai',async()=>({type:'oauth',access:'local-access',refresh:'local-refresh'}))`,
      { file: process.execPath, args: [join(directory, 'missing-native-helper.mjs')] },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /credential_private_file_failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const [layout, entry] of [
  ['source', new URL('../src/credentials.ts', import.meta.url)],
  ['compiled', new URL('../dist/project-agent/src/credentials.js', import.meta.url)],
] as const) {
  test(`Windows 默认 host 从 ${layout} 入口定位 TS helper，空 PATH 下完成凭据读写`, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'baton-default-host-'))
    const directory = join(parent, 'credentials with spaces')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
    }
    delete env.BATON_PRIVATE_FILE_HOST_COMMAND
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
    env.PATH = ''
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          tsxLoader,
          '--input-type=module',
          '-e',
          `
          const { FileCredentials } = await import(${JSON.stringify(entry.href)});
          // 只在调用方选择 Windows host；helper 子进程执行宿主系统的真实权限检查。
          Object.defineProperty(process, 'platform', {value:'win32'});
          const store = new FileCredentials(${JSON.stringify(directory)});
          await store.modify('xai', async () => ({type:'api_key',key:'local-default-host-key'}));
          if ((await store.read('xai')).key !== 'local-default-host-key') throw new Error('default_host_read_failed');
          console.log('default-host-complete');
          `,
        ],
        { env, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), 'default-host-complete')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
}
