import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import { AppError } from '../errors.ts'

export function isDeviceLoginCreateRequest(method: string, url: string): boolean {
  if (method !== 'POST') return false
  try {
    return decodeURI(new URL(url, 'http://localhost').pathname) === '/api/v1/device-auth/sessions'
  } catch {
    return false
  }
}

export class DeviceLoginRateError extends AppError {
  constructor(readonly retryAfter: number) {
    super(429, 'device_login_rate_limited', '设备登录尝试过于频繁，请稍后再试')
  }
}

/** Each application owns a bounded, expiring IP window, separate from employee login. */
export class DeviceLoginProtection {
  private readonly ip = new RateLimiterMemory({ points: 20, duration: 60 })

  async checkIP(ip: string): Promise<void> {
    try {
      await this.ip.consume(ip)
    } catch (error) {
      if (error instanceof RateLimiterRes)
        throw new DeviceLoginRateError(Math.max(1, Math.ceil(error.msBeforeNext / 1000)))
      throw error
    }
  }
}
