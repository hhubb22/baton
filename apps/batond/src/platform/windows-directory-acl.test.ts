import { expect, it } from 'vite-plus/test'
import { parseWindowsUserSid, validateWindowsDirectorySddl } from './files.ts'
import { powershell, systemCommand, windowsTool } from './identity.ts'

const sid = 'S-1-5-21-123-456-789-1001'

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
