import { execFileSync } from 'node:child_process'

process.send?.({
  group: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(),
})
process.disconnect?.()
