import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { agentNames, agentUnavailableReason, canCreateAgent } from '../data/derive'
import type { AgentKind, DeviceAgent } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Field, Input } from '../ui/Field'
import { Menu, MenuHeading, MenuOption } from '../ui/Menu'

export interface ThreadModelChoice {
  agent: AgentKind
  model: string
}

const styles = stylex.create({
  note: { paddingBlock: '6px', paddingInline: space.sm, color: colors.muted },
})

export function ThreadModelMenu({
  agents,
  choice,
  label,
  side = 'bottom',
  mode = 'create',
  lockedReason,
  onSelect,
  onUnavailable,
}: {
  agents: DeviceAgent[]
  choice: ThreadModelChoice | null
  label: string
  side?: 'top' | 'bottom'
  mode?: 'create' | 'switch'
  lockedReason?: string
  onSelect: (choice: ThreadModelChoice) => void
  onUnavailable?: (message: string) => void
}) {
  const [customAgent, setCustomAgent] = useState<DeviceAgent | null>(null)
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const selectCustom = () => {
    const id = model.trim()
    if (!id) {
      setError('Enter a model ID.')
      return
    }
    if (!customAgent) return
    onSelect({ agent: customAgent.kind, model: id })
    setCustomAgent(null)
  }
  return (
    <>
      <Menu side={side} trigger={<Chip icon="sparkle">{label}</Chip>}>
        {lockedReason ? (
          <>
            <p {...stylex.props(text.caption, styles.note)}>{lockedReason}</p>
            <MenuOption selected>{choice?.model || 'Default model'}</MenuOption>
          </>
        ) : (
          agents.map((agent) => (
            <div key={agent.kind}>
              <MenuHeading>{agentNames[agent.kind]}</MenuHeading>
              {mode === 'create' && !canCreateAgent(agent) ? (
                <MenuOption
                  note={agentUnavailableReason(agent)}
                  onSelect={() => onUnavailable?.(agentUnavailableReason(agent))}
                >
                  {agentNames[agent.kind]}
                </MenuOption>
              ) : (
                <>
                  {[
                    ...new Set([
                      ...(agent.models.length ? agent.models : ['']),
                      ...(choice?.agent === agent.kind ? [choice.model] : []),
                    ]),
                  ].map((id) => (
                    <MenuOption
                      key={id}
                      selected={choice?.agent === agent.kind && choice.model === id}
                      onSelect={() => onSelect({ agent: agent.kind, model: id })}
                    >
                      {id || 'Default model'}
                    </MenuOption>
                  ))}
                  <MenuOption
                    onSelect={() => {
                      setModel(choice?.agent === agent.kind ? choice.model : '')
                      setError(null)
                      setCustomAgent(agent)
                    }}
                  >
                    Enter model ID…
                  </MenuOption>
                </>
              )}
            </div>
          ))
        )}
      </Menu>
      <Dialog
        open={customAgent !== null}
        onOpenChange={(open) => {
          if (!open) setCustomAgent(null)
        }}
        title={`Choose ${customAgent ? agentNames[customAgent.kind] : ''} model`}
        actions={
          <>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button variant="primary" onClick={selectCustom}>
              Use model
            </Button>
          </>
        }
      >
        <Field label="Model ID" error={error}>
          {(props) => (
            <Input
              {...props}
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') selectCustom()
              }}
            />
          )}
        </Field>
      </Dialog>
    </>
  )
}
