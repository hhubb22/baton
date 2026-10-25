import { describe, expect, it } from 'vite-plus/test'
import { modelRejectedBeforeInput } from './model.ts'

describe('native model rejection evidence', () => {
  it.each([
    { agent: 'pi', error: { _tag: 'PiRpcError', operation: 'set_model' } },
    {
      agent: 'pi',
      error: {
        _tag: 'ProviderAdapterTurnStartError',
        driver: 'pi',
        cause: { _tag: 'PiRpcError', operation: 'set_model' },
      },
    },
    { agent: 'cursor', error: { _tag: 'CursorModelUnavailableError', model: 'unavailable' } },
  ])('recognizes $agent rejecting the model before submission', ({ agent, error }) => {
    expect(modelRejectedBeforeInput(agent, error)).toBe(true)
  })

  it.each([
    { agent: 'pi', error: { _tag: 'PiRpcTimeoutError', operation: 'set_model' } },
    {
      agent: 'pi',
      error: {
        _tag: 'ProviderAdapterTurnStartError',
        driver: 'pi',
        cause: { _tag: 'PiRpcTimeoutError', operation: 'set_model' },
      },
    },
    { agent: 'pi', error: { _tag: 'PiRpcError', operation: 'prompt' } },
    { agent: 'pi', error: { _tag: 'PiRpcError', operation: 'write' } },
    { agent: 'cursor', error: { _tag: 'CursorAgentSdkRunnerError', operation: 'send' } },
    { agent: 'codex', error: { _tag: 'ProviderAdapterTurnStartError' } },
    { agent: 'kiro', error: { _tag: 'PiRpcError', operation: 'set_model' } },
  ])('keeps uncertain $agent failures outside the rejection path', ({ agent, error }) => {
    expect(modelRejectedBeforeInput(agent, error)).toBe(false)
  })
})
