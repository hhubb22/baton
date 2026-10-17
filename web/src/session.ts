const csrfKey = 'baton_csrf'

export function readCSRF(): string {
  try {
    return sessionStorage.getItem(csrfKey) ?? ''
  } catch {
    return ''
  }
}

export function writeCSRF(token: string): void {
  sessionStorage.setItem(csrfKey, token)
}

export function clearCSRF(): void {
  try {
    sessionStorage.removeItem(csrfKey)
  } catch {
    // 隐私模式拒绝访问时，内存中的令牌仍会随页面卸载消失。
  }
}
