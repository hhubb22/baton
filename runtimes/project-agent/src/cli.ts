#!/usr/bin/env node
import { reportProjectRuntimeError, runProjectRuntimeCLI } from './command.js'

export { runProjectRuntimeCLI } from './command.js'

void runProjectRuntimeCLI(process.argv.slice(2)).catch(reportProjectRuntimeError)
