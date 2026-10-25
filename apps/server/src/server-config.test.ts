import { expect, test } from 'vite-plus/test'
import { controlConfiguration } from './server-config.ts'

test('control and RPC configuration keeps independent operation defaults and management capacity', () => {
  const config = controlConfiguration({})
  expect(config.controlBudgets.report).toEqual({ queueMs: 2000, executionMs: 15_000 })
  expect(config.controlBudgets.heartbeat).toEqual({ queueMs: 2000, executionMs: 3000 })
  expect(config.rpc).toMatchObject({ readConcurrency: 4, managementConcurrency: 2, maxQueued: 8, queueMs: 2000 })
  expect(config.rpc.timeouts).toEqual({
    'files.browse': 12_000,
    'session.request': 12_000,
    'node.project_exec_set': 5000,
    'node.browse_roots_set': 5000,
    'node.subscription_login': 12_000,
  })
})

test('configuration changes only the selected operation and RPC class', () => {
  const config = controlConfiguration({
    BATON_CONTROL_REPORT_QUEUE_TIMEOUT: '4s',
    BATON_CONTROL_REPORT_EXECUTION_TIMEOUT: '1m',
    BATON_RPC_READ_CONCURRENCY: '16',
    BATON_RPC_MANAGEMENT_CONCURRENCY: '3',
    BATON_RPC_MAX_QUEUED: '12',
    BATON_RPC_QUEUE_TIMEOUT: '500ms',
    BATON_RPC_MANAGEMENT_TIMEOUT: '20s',
  })
  expect(config.controlBudgets.report).toEqual({ queueMs: 4000, executionMs: 60_000 })
  expect(config.controlBudgets.heartbeat.executionMs).toBe(3000)
  expect(config.rpc).toMatchObject({ readConcurrency: 16, managementConcurrency: 3, maxQueued: 12, queueMs: 500 })
  expect(config.rpc.timeouts?.['node.project_exec_set']).toBe(20_000)
  expect(config.rpc.timeouts?.['session.request']).toBe(12_000)
})

test.each([
  ['BATON_CONTROL_REPORT_QUEUE_TIMEOUT', '0ms'],
  ['BATON_CONTROL_REPORT_EXECUTION_TIMEOUT', '121s'],
  ['BATON_RPC_READ_CONCURRENCY', '0'],
  ['BATON_RPC_MANAGEMENT_CONCURRENCY', '1.5'],
  ['BATON_RPC_MAX_QUEUED', '129'],
  ['BATON_RPC_QUEUE_TIMEOUT', '11s'],
  ['BATON_RPC_LOGIN_TIMEOUT', 'forever'],
])('rejects invalid %s', (name, value) => {
  expect(() => controlConfiguration({ [name]: value })).toThrow(`${name} 无效`)
})
