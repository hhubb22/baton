import { buildBatond } from '../build/batond.mjs'
import { runBundle } from './run-bundle.mjs'

runBundle(await buildBatond())
