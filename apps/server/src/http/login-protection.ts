import { createHash } from 'node:crypto'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import { AppError } from '../errors.ts'

export function isLoginRequest(method: string, url: string): boolean {
  if (method !== 'POST') return false
  try {
    return decodeURI(new URL(url, 'http://localhost').pathname) === '/api/v1/login'
  } catch {
    return false
  }
}

export class LoginRateError extends AppError {
  constructor(readonly retryAfter: number) {
    super(429, 'login_rate_limited', '登录尝试过于频繁，请稍后再试')
  }
}

export class LoginProtection {
  private readonly global = new RateLimiterMemory({ points: 120, duration: 60 })
  private readonly ip = new RateLimiterMemory({ points: 20, duration: 60 })
  private readonly account = new RateLimiterMemory({ points: 10, duration: 300 })
  private active = 0

  constructor(
    private readonly observe: (
      event: 'global' | 'ip' | 'account' | 'busy' | 'active',
      value: number,
    ) => void = () => {},
  ) {}

  private async consume(limiter: RateLimiterMemory, key: string, reason: 'global' | 'ip' | 'account'): Promise<void> {
    try {
      await limiter.consume(key)
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        this.observe(reason, 1)
        throw new LoginRateError(Math.max(1, Math.ceil(error.msBeforeNext / 1000)))
      }
      throw error
    }
  }

  async checkIP(ip: string): Promise<void> {
    await this.consume(this.global, 'global', 'global')
    await this.consume(this.ip, ip, 'ip')
  }

  async checkAccount(username: string): Promise<void> {
    await this.consume(this.account, createHash('sha256').update(username).digest('hex'), 'account')
  }

  run<A>(task: () => Promise<A>): Promise<A> {
    if (this.active >= 2) {
      this.observe('busy', 1)
      return Promise.reject(new AppError(503, 'login_busy', '暂时无法登录，请稍后再试'))
    }
    this.active++
    this.observe('active', this.active)
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.active--
        this.observe('active', this.active)
      })
  }
}
