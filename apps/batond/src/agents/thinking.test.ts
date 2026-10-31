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

it('retains ACP thought_level and Droid reasoning_effort options', () => {
  for (const id of ['thought_level', 'reasoning_effort'] as const) {
    expect(
      thinkingCapability({
        optionDescriptors: [
          {
            id,
            label: 'Effort',
            type: 'select',
            currentValue: 'low',
            options: [
              { id: 'low', label: 'Low', isDefault: true },
              { id: 'high', label: 'High' },
            ],
          },
        ],
      }),
    ).toEqual({
      id,
      current_value: 'low',
      options: [
        { id: 'low', label: 'Low', is_default: true },
        { id: 'high', label: 'High' },
      ],
    })
  }
})
