import { expect, it } from 'vite-plus/test'
import { thinkingCapability } from './thinking.ts'

it('retains provider-specific thinking options and ignores other model capabilities', () => {
  expect(
    thinkingCapability({
      optionDescriptors: [
        { id: 'serviceTier', label: 'Tier', type: 'select', options: [{ id: 'fast', label: 'Fast' }] },
        {
          id: 'reasoningEffort',
          label: 'Reasoning',
          type: 'select',
          currentValue: 'medium',
          options: [
            { id: 'medium', label: 'Medium', isDefault: true },
            { id: 'high', label: 'High' },
          ],
        },
      ],
    }),
  ).toEqual({
    id: 'reasoningEffort',
    current_value: 'medium',
    options: [
      { id: 'medium', label: 'Medium', is_default: true },
      { id: 'high', label: 'High' },
    ],
  })
  expect(
    thinkingCapability({ optionDescriptors: [{ id: 'thinking', label: 'Thinking', type: 'select', options: [] }] }),
  ).toBeUndefined()
})
