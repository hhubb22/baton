import { expect, it } from 'vite-plus/test'
import { sanitizeReplay } from './replay'

it('drops unknown arrays, attributes and URLs while retaining bounded layout and masked text', () => {
  const node = document.createElement('div')
  node.style.width = '123px'
  node.style.display = 'flex'
  const event = sanitizeReplay(
    {
      type: 2,
      data: {
        node: {
          id: 9,
          type: 2,
          tagName: 'div',
          attributes: { title: 'secret', href: '/secret' },
          childNodes: ['secret-array', { type: 3, textContent: 'private text', id: 10, unknown: ['secret'] }],
        },
      },
      unknown: ['secret'],
    },
    (id) => (id === 9 ? node : null),
  )
  const text = JSON.stringify(event)
  expect(text).toContain('width:123px')
  expect(text).toContain('display:flex')
  expect(text).toContain('******* ****')
  expect(text).not.toContain('secret')
  expect(text).not.toContain('private')
})
