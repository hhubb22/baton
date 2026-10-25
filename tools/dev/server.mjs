import { buildServer } from '../build/server.mjs'
import { runBundle } from './run-bundle.mjs'

runBundle(await buildServer())
