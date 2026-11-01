import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx|css)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

describe('动效 token', () => {
  it('过渡的时长和曲线都来自 token', () => {
    const literals = sources(root)
      // global.css 定义取值，画廊标本要并排比较同一时长下的曲线。
      .filter((path) => !path.endsWith('theme/global.css') && !path.includes('/dev/'))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => /cubic-bezier\(|transition[^\n]*\b[1-9]\d*m?s\b/.test(line))
          .map((line) => `${path.slice(root.length + 1)}: ${line.trim()}`),
      )
    expect(literals).toEqual([])
  })
})
