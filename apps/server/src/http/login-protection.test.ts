import { Effect, Fiber } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import { hashPassword, verifyPassword } from '../auth.ts'
import { LoginProtection, LoginRateError } from './login-protection.ts'

it('limits IP and account attempts in fixed windows without resetting on success', async () => {
  vi.useFakeTimers()
  try {
    const protection = new LoginProtection()
    for (let i = 0; i < 10; i++) {
      await protection.checkIP(`192.0.2.${i}`)
      await protection.checkAccount('employee')
    }
    vi.advanceTimersByTime(299_000)
    await expect(protection.checkAccount('employee')).rejects.toBeInstanceOf(LoginRateError)
    vi.advanceTimersByTime(1000)
    await expect(protection.checkAccount('employee')).resolves.toBeUndefined()
    for (let i = 0; i < 20; i++) await protection.checkIP('198.51.100.1')
    await expect(protection.checkIP('198.51.100.1')).rejects.toBeInstanceOf(LoginRateError)
  } finally {
    vi.useRealTimers()
  }
})

it('checks the global budget before allocating IP keys', async () => {
  const protection = new LoginProtection()
  for (let i = 0; i < 120; i++) await protection.checkIP(`192.0.2.${i}`)
  await expect(protection.checkIP('new-address')).rejects.toBeInstanceOf(LoginRateError)
})

it('retains a login permit when its waiting fiber is interrupted', async () => {
  const protection = new LoginProtection()
  let finish!: () => void
  const native = new Promise<void>((resolve) => {
    finish = resolve
  })
  const first = Effect.runFork(Effect.promise(() => protection.run(() => native)))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Effect.runPromise(Fiber.interrupt(first))
  const second = protection.run(() => native)
  await expect(protection.run(async () => {})).rejects.toMatchObject({ status: 503, code: 'login_busy' })
  finish()
  await second
  await expect(protection.run(async () => 'ok')).resolves.toBe('ok')
})

it('rejects excess work during real Argon2 operations', async () => {
  const events: Array<[string, number]> = []
  const protection = new LoginProtection((event, value) => events.push([event, value]))
  const hash = await hashPassword('sample-password-for-local-test')
  const attempts = Array.from({ length: 2 }, () =>
    protection.run(() => verifyPassword('sample-password-for-local-test', hash)),
  )
  await expect(protection.run(() => verifyPassword('sample-password-for-local-test', hash))).rejects.toMatchObject({
    status: 503,
    code: 'login_busy',
  })
  expect(await Promise.all(attempts)).toEqual([true, true])
  expect(events).toEqual([
    ['active', 1],
    ['active', 2],
    ['busy', 1],
    ['active', 1],
    ['active', 0],
  ])
})
