import { expect, it } from 'vite-plus/test'
import { sourceLocation } from './source'

it('accepts only the current static build asset and bounded line and column', () => {
  const asset = 'https://baton.local/assets/index-ABCdef123.js'
  expect(sourceLocation(asset, 17, 9, asset)).toEqual({
    'baton.web.source.asset': 'index-ABCdef123.js',
    'code.line.number': 17,
    'code.column.number': 9,
  })
  for (const source of [
    'https://other.local/assets/index-ABCdef123.js',
    'https://baton.local/assets/secret-ABCdef123.js',
    `${asset}?secret=value`,
    '/private/path',
  ])
    expect(sourceLocation(source, 17, 9, asset)).toBeUndefined()
  expect(sourceLocation(asset, 0, 9, asset)).toBeUndefined()
  expect(sourceLocation(asset, 17, 10_000_001, asset)).toBeUndefined()
})
