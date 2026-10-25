import { reportBatondError, runBatondCLI } from './cli.ts'

void runBatondCLI().catch(reportBatondError)
