import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { readProjectPreview, saveProjectPreview } from './preview.ts'

it('clears a preview and accepts a new history boundary without waiting for the throttle', async () => {
  const run = randomUUID()
  const save = (after: number, text: string) =>
    Effect.runPromise(saveProjectPreview(run, after, { text, truncated: false }))
  const read = (after: number) => Effect.runPromise(readProjectPreview(run, after))

  await save(2, 'First draft')
  await save(2, 'Throttled update')
  expect((await read(2))?.text).toBe('First draft')
  await save(2, '')
  expect((await read(2))?.text).toBe('')
  await save(2, 'Retry draft')
  expect((await read(2))?.text).toBe('Retry draft')
  await save(3, 'Next response')
  expect(await read(2)).toBeUndefined()
  expect((await read(3))?.text).toBe('Next response')
})
