import { describe, expect, it } from 'vite-plus/test'
import { loginClientIp, parseTrustedProxies } from './login-ip.ts'

describe('login client address', () => {
  it('uses the socket by default and ignores untrusted forwarded headers', () => {
    expect(loginClientIp('192.0.2.7', '198.51.100.1', [])).toBe('192.0.2.7')
    expect(loginClientIp('192.0.2.7', '198.51.100.1', parseTrustedProxies('10.0.0.0/8'))).toBe('192.0.2.7')
    expect(loginClientIp(undefined, '198.51.100.1', [])).toBeUndefined()
    expect(loginClientIp('invalid', '198.51.100.1', [])).toBeUndefined()
  })

  it('walks trusted proxies from the right and disregards attacker-provided left hops', () => {
    const proxies = parseTrustedProxies('10.0.0.0/8, 192.0.2.0/24')
    expect(loginClientIp('10.0.0.1', '203.0.113.9, 198.51.100.7, 192.0.2.9', proxies)).toBe('198.51.100.7')
    expect(loginClientIp('10.0.0.1', '198.51.100.7, 192.0.2.9', proxies)).toBe('198.51.100.7')
    expect(loginClientIp('10.0.0.1', '192.0.2.8, 192.0.2.9', proxies)).toBe('192.0.2.8')
  })

  it('falls back to the peer on malformed or oversized trusted chains', () => {
    const proxies = parseTrustedProxies('10.0.0.0/8')
    expect(loginClientIp('10.0.0.1', '198.51.100.1, not-an-address', proxies)).toBe('10.0.0.1')
    expect(loginClientIp('10.0.0.1', '198.51.100.1:1234', proxies)).toBe('10.0.0.1')
    expect(loginClientIp('10.0.0.1', Array(65).fill('10.0.0.2').join(','), proxies)).toBe('10.0.0.1')
    expect(loginClientIp('10.0.0.1', 'x'.repeat(8193), proxies)).toBe('10.0.0.1')
  })

  it('normalizes mapped IPv4 and groups native IPv6 by /64', () => {
    const proxies = parseTrustedProxies('::ffff:10.0.0.0/104, 2001:db8:1::/48')
    expect(loginClientIp('::ffff:10.0.0.1', '::ffff:198.51.100.9', proxies)).toBe('198.51.100.9')
    expect(loginClientIp('2001:db8:1::5', '2001:db8:abcd:12::42', proxies)).toBe('2001:db8:abcd:12::/64')
    expect(loginClientIp('2001:db8:abcd:12:ffff::1', undefined, [])).toBe('2001:db8:abcd:12::/64')
    expect(loginClientIp('fe80::1234%en0', undefined, [])).toBe('fe80:0:0:0::/64')
  })

  it('rejects malformed trusted proxy configuration', () => {
    for (const cidr of [
      '192.0.2.1',
      '192.0.2.1/33',
      '10.0.0.0/-1',
      '2001:db8::/129',
      '::ffff:10.0.0.1/95',
      'bad/8',
      '10.0.0.1/8,',
    ])
      expect(() => parseTrustedProxies(cidr)).toThrow('Invalid trusted proxy CIDR')
    expect(parseTrustedProxies('')).toEqual([])
  })
})
