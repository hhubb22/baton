import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { readUpgradeState, saveUpgradeState, type UpgradeState } from './upgrade.ts'

vi.mock('../platform/private.ts', async (original) => ({
  ...(await original<typeof import('../platform/private.ts')>()),
  readPrivateFile: vi.fn(),
  writePrivateFileAtomic: vi.fn(),
}))

const draining: UpgradeState = {
  operation_id: 'cancel-operation',
  source_version: 'development',
  target_version: 'development',
  phase: 'draining',
}
const cancelled: UpgradeState = { ...draining, phase: 'cancelled' }

beforeEach(() => {
  let contents = Buffer.from(JSON.stringify(draining))
  vi.mocked(readPrivateFile)
    .mockReset()
    .mockImplementation(async () => {
      const opened = contents
      // 私有文件在打开前后核对文件身份；原子替换发生在这期间会使读取失败。
      await Promise.resolve()
      if (opened !== contents) throw new Error('Private file changed during open')
      return opened
    })
  vi.mocked(writePrivateFileAtomic)
    .mockReset()
    .mockImplementation(async (_path, data) => {
      contents = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    })
})

it('reads a complete snapshot when cancellation replaces the state file during a read', async () => {
  const [state] = await Promise.all([
    readUpgradeState('/upgrade-state'),
    saveUpgradeState('/upgrade-state/.', cancelled),
  ])
  expect(state).toEqual(draining)
  expect(await readUpgradeState('/upgrade-state')).toEqual(cancelled)
})

it('keeps invalid state errors visible and permits subsequent state access', async () => {
  vi.mocked(readPrivateFile).mockRejectedValueOnce(new Error('Invalid private file type'))
  await expect(readUpgradeState('/upgrade-state')).rejects.toMatchObject({ code: 'upgrade_state_invalid' })
  await saveUpgradeState('/upgrade-state', cancelled)
  expect(await readUpgradeState('/upgrade-state')).toEqual(cancelled)
})
