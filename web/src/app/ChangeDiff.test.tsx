import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vite-plus/test'
import { ChangeDiff } from './ChangeDiff'

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string; hunks: unknown[] } }) => (
    <div>
      Parsed {fileDiff.name}: {fileDiff.hunks.length} hunk
    </div>
  ),
}))

it('renders a hunk-only patch', () => {
  const patch = '@@ -1 +1 @@\n-old\n+new\n'
  render(<ChangeDiff path="/work/example.ts" patch={patch} fallback={<span>Raw fallback</span>} />)
  expect(screen.getByText('Parsed example.ts: 1 hunk')).toBeInTheDocument()
  expect(screen.queryByText('Original patch')).not.toBeInTheDocument()
})

it('shows provider errors as raw output', () => {
  render(<ChangeDiff patch="Could not find the text" fallback={<span>Could not find the text</span>} />)
  expect(screen.getByText('Could not find the text')).toBeInTheDocument()
})
