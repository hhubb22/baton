import { expect, it } from 'vite-plus/test'
import { queryTerms, terms } from './lexical.ts'

// 人工固定语料：包含中文相邻字、英文变体和技术标识符，无模型生成数据。
it('normalizes Chinese bigrams, NFKC, case and identifiers without losing exact terms', () => {
  expect(terms('部署测试', true)).toEqual(['部署', '署测', '测试'])
  expect(queryTerms('Baton长期记忆').terms).toEqual(queryTerms('Baton 长期记忆').terms)
  expect(queryTerms('Baton长期记忆').terms).toEqual(['baton', '长期', '期记', '记忆'])
  expect(terms('库', true)).toEqual(['库'])
  expect(terms('ＦooBar foo_bar /src/runtime.ts', true)).toEqual([
    'foobar',
    'foo',
    'bar',
    'foo_bar',
    'foo',
    'bar',
    '/src/runtime.ts',
    'src',
    'runtime',
    'ts',
  ])
  expect(queryTerms('x '.repeat(2000)).truncated).toBe(true)
  expect(queryTerms(Array.from({ length: 140 }, (_, i) => 't' + i).join(' ')).terms).toHaveLength(128)
})
