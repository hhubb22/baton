import { expect, it } from 'vite-plus/test'
import {
  createDirectoryAclCache,
  createNumericWindowsSid,
  parseWindowsUserSid,
  validateWindowsDirectorySddl,
  validateWindowsDirectoryAclReadback,
} from './files.ts'
import { powershell, systemCommand, windowsTool } from './identity.ts'

const sid = 'S-1-5-21-123-456-789-1001'

it('validates the actual DACL read back after protection with the same strict rules', async () => {
  await validateWindowsDirectoryAclReadback(`D:PAI(A;OICI;FA;;;LA)\r\n${sid}`, sid)
  for (const [sddl, trustee] of [
    ['D:AI(A;OICIID;FA;;;LA)', sid],
    ['D:P(A;OICI;FA;;;BA)', 'S-1-5-32-544'],
    [`D:P(A;OICI;FR;;;${sid})`, sid],
    [`D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;WD)`, sid],
    ['D:P(A;OICI;FA;;;S-1-5-21-123-456-789-500)', sid],
  ]) {
    await expect(validateWindowsDirectoryAclReadback(`${sddl}\n${trustee}`, sid)).rejects.toThrow(`SDDL: ${sddl}`)
  }
  await expect(validateWindowsDirectoryAclReadback('', sid)).rejects.toThrow('SDDL: <missing>')
})

it('checks a directory again when its device or inode changes and never caches failures or missing identities', async () => {
  const checked: string[] = []
  const cache = createDirectoryAclCache(async (path) => {
    checked.push(path)
    if (checked.length === 3) throw new Error('Invalid private directory ACL')
  })
  const path = 'private-directory'
  await Promise.all([cache.validate(path, { dev: 1, ino: 2 }), cache.validate(path, { dev: 1, ino: 2 })])
  await cache.validate(path, { dev: 1, ino: 2 })
  await cache.validate(path, { dev: 2, ino: 2 })
  await expect(cache.validate(path, { dev: 2, ino: 3 })).rejects.toThrow('Invalid private directory ACL')
  await cache.validate(path, { dev: 2, ino: 3 })
  await cache.validate(path, { dev: 2, ino: 0 })
  await cache.validate(path, { dev: 2, ino: 0 })
  await cache.validate(path, { dev: 2, ino: 3 })
  expect(checked).toHaveLength(7)
})

it('retries SID abbreviations after a failed resolution without caching the rejection', async () => {
  let attempts = 0
  const numeric = createNumericWindowsSid(async () => {
    if (++attempts === 1) throw new Error('PowerShell timed out')
    return sid
  })
  const first = await Promise.allSettled([numeric('LA'), numeric('LA')])
  expect(first.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(await numeric('LA')).toBe(sid)
  expect(await numeric('LA')).toBe(sid)
  expect(attempts).toBe(2)
  expect(await numeric(sid)).toBe(sid)
})

it('accepts the protected inheritable full-control ACE for the numeric current user SID', async () => {
  await validateWindowsDirectorySddl(`D:P(A;OICI;FA;;;${sid})`, sid)
  await validateWindowsDirectorySddl(`D:PAI(A;OICI;FA;;;${sid})S:PAINO_ACCESS_CONTROL`, sid)
  await validateWindowsDirectorySddl(`D:PAI(A;OICI;FA;;;${sid})S:(AU;SA;FA;;;WD)`, sid)
})

it('rejects inheritance, extra principals, partial rights and altered ACE fields with the actual SDDL', async () => {
  for (const sddl of [
    `D:AI(A;OICIID;FA;;;${sid})`,
    `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;S-1-5-32-544)`,
    `D:P(A;OICI;FA;;;S-1-5-21-123-456-789-500)`,
    ...['CI', 'OI', 'OICIID', 'OICIIO', 'OICINP'].map((flags) => `D:P(A;${flags};FA;;;${sid})`),
    `D:P(A;OICI;FR;;;${sid})`,
    `D:P(D;OICI;FA;;;${sid})`,
    `D:P(A;OICI;FA;object;;${sid})`,
    `D:P(A;OICI;FA;;object;${sid})`,
  ]) {
    await expect(validateWindowsDirectorySddl(sddl, sid)).rejects.toThrow(`SDDL: ${sddl}`)
  }
  await expect(validateWindowsDirectorySddl(undefined, sid)).rejects.toThrow('SDDL: <missing>')
})

it.skipIf(process.platform !== 'win32')('resolves SDDL SID abbreviations before comparing numeric SIDs', async () => {
  const administrator = await powershell(
    "([System.Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)')).DiscretionaryAcl[0].SecurityIdentifier.Value",
  )
  await validateWindowsDirectorySddl('D:P(A;OICI;FA;;;LA)', administrator)
  await expect(validateWindowsDirectorySddl('D:P(A;OICI;FA;;;LA)', sid)).rejects.toThrow('SDDL: D:P(A;OICI;FA;;;LA)')
})

it.skipIf(process.platform !== 'win32').each(['BA', 'BU', 'WD', 'LG'])(
  'rejects a non-current SDDL trustee %s',
  async (trustee) => {
    const current = parseWindowsUserSid(await systemCommand(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']))
    await expect(validateWindowsDirectorySddl(`D:P(A;OICI;FA;;;${trustee})`, current)).rejects.toThrow(
      'Invalid private',
    )
  },
)
