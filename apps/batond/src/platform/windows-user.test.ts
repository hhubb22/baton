import { expect, it } from 'vite-plus/test'
import { parseWindowsUserSid } from './files.ts'

it('reads the numeric SID column independently of localized or misleading display names', () => {
  const sid = 'S-1-5-21-123-456-789-1001'
  for (const name of ['HOST\\runneradmin', 'HOST\\S-1-11-22', 'HOST\\用户,"display"']) {
    const quoted = name.replaceAll('"', '""')
    expect(parseWindowsUserSid(`"${quoted}","${sid}"\r\n`)).toBe(sid)
  }
  expect(() => parseWindowsUserSid('"HOST\\runneradmin","unknown"')).toThrow('Windows user SID')
})
