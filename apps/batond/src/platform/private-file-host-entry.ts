import { runPrivateFileHost } from './private-file-host.ts'

process.exitCode = await runPrivateFileHost(process.argv.slice(2))
if (process.exitCode !== 0 && process.exitCode !== 3) process.stderr.write('credential_private_file_failed\n')
