import { expect, it } from 'vite-plus/test'
import { compareUpdateVersions } from './update-version.ts'

it('orders releases and prereleases, and rejects invalid versions', () => {
  expect(compareUpdateVersions('v2.0.0', 'v1.99.99')).toBe(1)
  expect(compareUpdateVersions('v1.0.0', 'v1.0.0-rc.10')).toBe(1)
  expect(compareUpdateVersions('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBe(-1)
  expect(compareUpdateVersions('v1.0.0-1', 'v1.0.0-alpha')).toBe(-1)
  expect(compareUpdateVersions('v1.0.0', 'v1.0.0')).toBe(0)
  expect(() => compareUpdateVersions('development', 'v1.0.0')).toThrow()
  expect(() => compareUpdateVersions('v1.0.0-rc.01', 'v1.0.0')).toThrow()
})
