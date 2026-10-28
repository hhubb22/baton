import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { editorPreferences } from './editor.ts'

it('defaults to the system application and persists a native editor choice privately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-editor-'))
  try {
    const settings = await editorPreferences(directory)
    expect(settings.get()).toBeNull()
    const editor = join(directory, 'Editor.app')
    await settings.set(editor)
    expect((await editorPreferences(directory)).get()).toBe(editor)
    expect(JSON.parse(await readFile(join(directory, 'editor.json'), 'utf8'))).toEqual({ editor })
    if (process.platform !== 'win32') expect((await stat(join(directory, 'editor.json'))).mode & 0o777).toBe(0o600)
    await expect(settings.set('editor --arbitrary-argument')).rejects.toThrow('Choose an editor')
    expect(settings.get()).toBe(editor)
    await settings.set(null)
    expect((await editorPreferences(directory)).get()).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
