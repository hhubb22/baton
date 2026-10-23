import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import fixtures from '../test/fixtures/baton-codex-0.162.1.json' with { type: 'json' }
import { CLIENT_REQUEST_RESPONSES, SERVER_NOTIFICATION_PARAMS } from './_generated/meta.gen.ts'

const responses: Record<string, Schema.ConstraintDecoder<unknown>> = CLIENT_REQUEST_RESPONSES
const notifications: Record<string, Schema.ConstraintDecoder<unknown> | undefined> = SERVER_NOTIFICATION_PARAMS

describe('Codex 0.162.1 recorded protocol compatibility', () => {
  for (const fixture of fixtures) {
    it(fixture.source + ':' + fixture.label, () => {
      const schema = (fixture.kind === 'response' ? responses : notifications)[fixture.method]
      expect(schema, fixture.method).toBeDefined()
      // Go's replay normalizer removes both platform fields from initialize responses.
      const payload =
        fixture.method === 'initialize'
          ? { ...fixture.payload, platformFamily: 'unix', platformOs: 'macos' }
          : fixture.payload
      expect(() => Schema.decodeUnknownSync(schema as Schema.ConstraintDecoder<unknown>)(payload)).not.toThrow()
    })
  }
})
