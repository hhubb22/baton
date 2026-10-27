import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { assertWorkerDependencies } from './build/worker-dependencies.mjs'

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'baton-worker-graph-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sources = {
    'apps/batond/src/daemon/worker-runner.ts': '',
    'apps/batond/src/worker/index.ts': '',
    ...files,
  }
  for (const [name, contents] of Object.entries(sources)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  return realpath(root)
}

const source = 'apps/batond/src/'

test('运行时图保留静态导入、re-export、字面量 import 和 require，处理循环与 external', async (t) => {
  const root = await fixture(t, {
    [`${source}daemon/worker-runner.ts`]: "import '../worker/index.ts'; import 'node:fs'",
    [`${source}worker/index.ts`]: "export { value } from './barrel.ts'; export * from './barrel.ts'",
    [`${source}worker/barrel.ts`]: 'export const value = () => import(`./lazy.ts`)',
    [`${source}worker/lazy.ts`]: "const dependency = require('./required.cjs'); export { dependency }",
    [`${source}worker/required.cjs`]: "require('./cycle.mjs'); require('allowed-external')",
    [`${source}worker/cycle.mjs`]: "import './index.ts'",
  })
  const graph = await assertWorkerDependencies({ root, external: ['allowed-external'] })
  // 断言用正斜杠，Windows 的 relative() 返回反斜杠。
  const shown = (path) => relative(root, path).split(sep).join('/')
  assert.deepEqual(
    [...graph].map(shown).sort((a, b) => a.localeCompare(b)),
    [
      `${source}daemon/worker-runner.ts`,
      `${source}worker/index.ts`,
      `${source}worker/barrel.ts`,
      `${source}worker/lazy.ts`,
      `${source}worker/required.cjs`,
      `${source}worker/cycle.mjs`,
    ].sort((a, b) => a.localeCompare(b)),
  )
})

test('type import、type re-export 和 import type query 不进入运行时图', async (t) => {
  const root = await fixture(t, {
    [`${source}worker/index.ts`]: `
      import type { Driver } from '../agents/cursor/host-driver.ts'
      import type { SDK } from '@cursor/sdk'
      export type * from '../cli.ts'
      export type { Probe } from '../agents/probe.ts'
      type Host = import('../agent-host/host.ts').Host
      export const value = 1
    `,
  })
  assert.equal((await assertWorkerDependencies({ root })).size, 2)
})

for (const statement of ["import { type SDK } from '@cursor/sdk'", "export { type SDK } from '@cursor/sdk'"]) {
  test(`verbatimModuleSyntax 保留 ${statement} 的包加载副作用`, async (t) => {
    const root = await fixture(t, { [`${source}worker/index.ts`]: statement })
    await assert.rejects(assertWorkerDependencies({ root }), /forbidden runtime dependency[\s\S]*@cursor\/sdk/)
  })
}

for (const forbidden of [
  'cli.ts',
  'cli/agent-host.ts',
  'agents/probe.ts',
  'agents/cursor/host-module.ts',
  'agents/pi/host-driver.ts',
  'agent-host/host.ts',
  'agent-host/host-layer.ts',
  'agent-host/driver.ts',
  'agents/cursor/sdk-loader.ts',
]) {
  test(`聚合 re-export 绕入 ${forbidden} 时拒绝并报告路径`, async (t) => {
    const root = await fixture(t, {
      [`${source}worker/index.ts`]: "import './barrel.ts'",
      [`${source}worker/barrel.ts`]: `export * from '../${forbidden}'`,
      [`${source}${forbidden}`]: 'export const value = 1',
    })
    await assert.rejects(assertWorkerDependencies({ root }), (error) => {
      assert.match(error.message, /forbidden runtime dependency/)
      assert.ok(error.message.includes('worker/index.ts -> apps/batond/src/worker/barrel.ts'))
      assert.ok(error.message.includes(forbidden))
      return true
    })
  })
}

for (const [name, statement] of [
  ['动态 import', "export const load = () => import('../agents/cursor/host-driver.ts')"],
  ['require', "const host = require('../agents/cursor/host-driver.ts')"],
  ['require alias', "const load = require; load('../agents/cursor/host-driver.ts')"],
  [
    'createRequire alias',
    "import { createRequire as create } from 'node:module'; const load = create(import.meta.url); load('../agents/cursor/host-driver.ts')",
  ],
  ['import equals', "import host = require('../agents/cursor/host-driver.ts'); export { host }"],
  ['mixed import', "import { type Driver, host } from '../agents/cursor/host-driver.ts'; export { host }"],
]) {
  test(`${name} 绕入 host driver 时拒绝`, async (t) => {
    const root = await fixture(t, {
      [`${source}daemon/worker-runner.ts`]: statement,
      [`${source}agents/cursor/host-driver.ts`]: 'export const host = 1',
    })
    await assert.rejects(assertWorkerDependencies({ root }), /forbidden runtime dependency[\s\S]*host-driver\.ts/)
  })
}

for (const name of [
  '@cursor/sdk',
  '@cursor/sdk/sqlite',
  '@t3tools/provider-core/server/ProviderHost',
  '@t3tools/provider-cursor/server',
  'effect-acp',
  'effect-codex-app-server/schema',
  '@earendil-works/pi-ai',
]) {
  test(`external ${name} 仍禁止进入 Worker`, async (t) => {
    const root = await fixture(t, {
      [`${source}worker/index.ts`]: `export const load = () => import(${JSON.stringify(name)})`,
    })
    await assert.rejects(assertWorkerDependencies({ root, external: [name] }), (error) => {
      assert.match(error.message, /forbidden runtime dependency/)
      assert.ok(error.message.includes(name))
      return true
    })
  })
}

test('遍历 package exports 和包内传递依赖', async (t) => {
  const root = await fixture(t, {
    [`${source}worker/index.ts`]: "import 'wrapper'",
    'node_modules/wrapper/package.json': JSON.stringify({ name: 'wrapper', exports: './runtime.mjs' }),
    'node_modules/wrapper/runtime.mjs': "export * from '@t3tools/provider-pi/server'",
  })
  await assert.rejects(
    assertWorkerDependencies({ root }),
    /forbidden runtime dependency[\s\S]*wrapper\/runtime\.mjs[\s\S]*@t3tools\/provider-pi/,
  )
})

for (const expression of [
  'import(path)',
  'import(`./${name}.ts`)',
  "import('./' + name + '.ts')",
  'require(path)',
  'require.resolve(path)',
  'module.require(path)',
]) {
  test(`本地源码拒绝无法静态解析的 ${expression}`, async (t) => {
    const root = await fixture(t, {
      [`${source}worker/index.ts`]: `export const load = (path, name) => ${expression}`,
    })
    await assert.rejects(assertWorkerDependencies({ root }), /non-static .*worker\/index\.ts:\d+:\d+/)
  })
}

test('createRequire 别名拒绝无法静态解析的加载和基准路径', async (t) => {
  for (const statement of [
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load(name)",
    "import * as Module from 'node:module'; const load = Module.createRequire(base); load('node:fs')",
  ]) {
    const root = await fixture(t, { [`${source}worker/index.ts`]: statement })
    await assert.rejects(assertWorkerDependencies({ root }), /non-static/)
  }
})

test('第三方包在 try/catch 中加载缺失可选包时按 external 处理，仍检查禁入名称', async (t) => {
  const root = await fixture(t, {
    [`${source}worker/index.ts`]: "import 'wrapper'",
    'node_modules/wrapper/package.json': JSON.stringify({ name: 'wrapper', main: './index.cjs' }),
    'node_modules/wrapper/index.cjs': "try { require('missing-optional') } catch {}",
  })
  assert.equal((await assertWorkerDependencies({ root })).size, 3)
  await writeFile(join(root, 'node_modules/wrapper/index.cjs'), "try { require('@cursor/sdk') } catch {}")
  await assert.rejects(assertWorkerDependencies({ root }), /forbidden runtime dependency[\s\S]*@cursor\/sdk/)
})

test('无法解析的字面量依赖令检查失败', async (t) => {
  const root = await fixture(t, {
    [`${source}worker/index.ts`]: "import './missing.ts'",
  })
  await assert.rejects(assertWorkerDependencies({ root }), /cannot resolve .\/missing\.ts/)
})
