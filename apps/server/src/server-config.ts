import { AppError } from './errors.ts'
import {
  defaultControlBudgets,
  type ControlBudget,
  type ControlBudgets,
  type ControlOperation,
} from './control-budget.ts'
import type { GatewayOptions } from './gateway.ts'

type Environment = Readonly<Record<string, string | undefined>>

export function duration(
  name: string,
  fallback: number,
  minimum = 100,
  maximum = 3_600_000,
  env: Environment = process.env,
): number {
  const raw = env[name]
  if (!raw) return fallback
  const match = /^(\d+)(ms|s|m|h)$/.exec(raw)
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const value = match ? Number(match[1]) * scale[match[2]] : NaN
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new AppError(400, 'invalid_configuration', `${name} 无效`)
  return value
}

function count(env: Environment, name: string, fallback: number, maximum: number): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new AppError(400, 'invalid_configuration', `${name} 无效`)
  return value
}

export function controlConfiguration(env: Environment = process.env) {
  const budget = (operation: ControlOperation): ControlBudget => {
    const defaults = defaultControlBudgets[operation]
    const prefix = `BATON_CONTROL_${operation.toUpperCase()}`
    return {
      queueMs: duration(`${prefix}_QUEUE_TIMEOUT`, defaults.queueMs, 100, 60_000, env),
      executionMs: duration(`${prefix}_EXECUTION_TIMEOUT`, defaults.executionMs, 100, 120_000, env),
    }
  }
  const controlBudgets: ControlBudgets = {
    authenticate: budget('authenticate'),
    validate: budget('validate'),
    heartbeat: budget('heartbeat'),
    disconnect: budget('disconnect'),
    sync: budget('sync'),
    runtime_report: budget('runtime_report'),
    project_request: budget('project_request'),
    receipt: budget('receipt'),
    report: budget('report'),
    browser: budget('browser'),
    read: budget('read'),
    dispatch: budget('dispatch'),
    schedule: budget('schedule'),
    maintenance: budget('maintenance'),
  }
  const rpc: NonNullable<GatewayOptions['rpc']> = {
    readConcurrency: count(env, 'BATON_RPC_READ_CONCURRENCY', 4, 64),
    managementConcurrency: count(env, 'BATON_RPC_MANAGEMENT_CONCURRENCY', 2, 64),
    maxQueued: count(env, 'BATON_RPC_MAX_QUEUED', 8, 128),
    queueMs: duration('BATON_RPC_QUEUE_TIMEOUT', 2000, 100, 10_000, env),
    timeouts: {
      'files.browse': duration('BATON_RPC_READ_TIMEOUT', 12_000, 100, 120_000, env),
      'session.request': duration('BATON_RPC_READ_TIMEOUT', 12_000, 100, 120_000, env),
      'node.project_exec_set': duration('BATON_RPC_MANAGEMENT_TIMEOUT', 5000, 100, 120_000, env),
      'node.browse_roots_set': duration('BATON_RPC_MANAGEMENT_TIMEOUT', 5000, 100, 120_000, env),
      'node.subscription_login': duration('BATON_RPC_LOGIN_TIMEOUT', 12_000, 100, 120_000, env),
    },
  }
  return { controlBudgets, rpc }
}
