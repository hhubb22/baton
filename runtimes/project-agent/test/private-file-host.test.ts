import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

test('结构化 Node host 经真实 TS helper 保存、读取、串行刷新及删除本地凭据', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'baton-native-argv-'))
  const directory = join(parent, 'credentials with spaces ; $literal')
  try {
    const result = invoke(
      directory,
      `
      await store.modify('openai-codex',async()=>({type:'oauth',access:'local-access',refresh:'local-refresh',expires:0}));
      await Promise.all([1,2,3].map(()=>store.modify('openai-codex',async value=>({...value,expires:value.expires+1}))));
      if((await store.read('openai-codex')).expires!==3) throw new Error('refresh_not_serialized');
      if((await store.list()).length!==1) throw new Error('credential_list_missing');
      const {probe}=await import(${JSON.stringify(new URL('../src/auth.ts', import.meta.url).href)});
      const report=await probe(store);
      if(report.providers[0].status!=='available'||report.providers[1].status!=='login_required') throw new Error('credential_probe_failed');
      await store.delete('openai-codex');
      if(await store.read('openai-codex')!==undefined) throw new Error('credential_delete_failed');
      await store.modify('xai',async()=>({type:'oauth',access:'local-access',refresh:'local-refresh'}));
      console.log('private-host-complete');
    `,
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'private-host-complete')
    assert.equal(JSON.parse(await readFile(join(directory, 'xai.json'), 'utf8')).type, 'oauth')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
