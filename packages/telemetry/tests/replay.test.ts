import { expect, it } from 'vite-plus/test'
import { sanitizeReplay } from '../src/replay.ts'

it('过滤来自不可信回放的内容和样式，同时保留安全布局', () => {
  const result = sanitizeReplay({
    type: 2,
    data: {
      node: {
        id: 1,
        tagName: 'div',
        attributes: { style: 'width:100px;display:flex;background:url(secret);height:25px', title: 'secret' },
        childNodes: [{ type: 3, textContent: 'secret text' }],
      },
      href: 'https://secret.example',
      custom: ['secret'],
    },
  })
  expect(result).toEqual({
    type: 2,
    data: {
      node: {
        id: 1,
        tagName: 'div',
        attributes: { style: 'width:100px;display:flex;height:25px' },
        childNodes: [{ type: 3, textContent: '****** ****' }],
      },
    },
  })
})
