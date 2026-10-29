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
import openaiMark from '../../../upstream/t3code/apps/marketing/public/harnesses/openai_dark.svg?raw'
import cursorMark from '../../../upstream/t3code/apps/marketing/public/harnesses/cursor_light.svg?raw'

export interface ThreadModelChoice {
  agent: AgentKind
  model: string
}

const styles = stylex.create({
  note: { paddingBlock: '6px', paddingInline: space.sm, color: colors.muted },
  providerIcon: { display: 'inline-flex', flexShrink: 0, width: '16px', height: '16px', color: colors.muted },
  search: {
    width: '100%',
    minHeight: '36px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colors.text,
    '::placeholder': { color: colors.faint },
  },
})

function ProviderIcon({ agent }: { agent: AgentKind }) {
  const props = { ...stylex.props(styles.providerIcon), 'aria-hidden': true, title: agentNames[agent] }
  if (agent === 'codex' || agent === 'cursor') {
    const svg = (agent === 'codex' ? openaiMark : cursorMark)
      .replaceAll('fill="#fff"', 'fill="currentColor"')
      .replaceAll('fill="#EDECEC"', 'fill="currentColor"')
      .replace('<svg ', '<svg width="100%" height="100%" ')
    return <span {...props} dangerouslySetInnerHTML={{ __html: svg }} />
  }
  if (agent === 'pi')
    return (
      <span {...props}>
        <svg viewBox="165.29 165.29 469.43 469.43" width="100%" height="100%" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
          />
          <path d="M517.36 400H634.72V634.72H517.36Z" />
        </svg>
      </span>
    )
  return (
    <span {...props}>
      <svg viewBox="0 0 1200 1200" width="100%" height="100%" fill="none">
        <rect width="1200" height="1200" rx="260" fill="#9046FF" />
        <path
          d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
          fill="#fff"
        />
        <path
          d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z"
          fill="#000"
        />
        <path
          d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"
          fill="#000"
        />
      </svg>
    </span>
  )
}

export function ThreadModelMenu({
  agents,
  choice,
  label,
  accessibleLabel,
  side = 'bottom',
  mode = 'create',
  lockedReason,
  onSelect,
  onUnavailable,
}: {
  agents: DeviceAgent[]
  choice: ThreadModelChoice | null
  label: string
  accessibleLabel?: string
  side?: 'top' | 'bottom'
  mode?: 'create' | 'switch'
  lockedReason?: string
  onSelect: (choice: ThreadModelChoice) => void
  onUnavailable?: (message: string) => void
}) {
  const [customAgent, setCustomAgent] = useState<DeviceAgent | null>(null)
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const visibleAgents = agents.map((agent) => {
    const models = [
      ...new Set([
        ...(agent.models.length ? agent.models : ['']),
        ...(choice?.agent === agent.kind ? [choice.model] : []),
      ]),
    ]
    const matchesAgent = agentNames[agent.kind].toLowerCase().includes(query)
    const matches = query && !matchesAgent ? models.filter((id) => id.toLowerCase().includes(query)) : models
    return { agent, models: matches, matchesAgent }
  })
  const selectCustom = () => {
    const id = model.trim()
    if (!id) {
      setError('请输入模型 ID。')
      return
    }
    if (!customAgent) return
    onSelect({ agent: customAgent.kind, model: id })
    setCustomAgent(null)
  }
  return (
    <>
      <Menu
        side={side}
        onOpenChange={(open) => {
          if (!open) setSearch('')
        }}
        trigger={
          <Chip
            icon={choice ? undefined : 'sparkle'}
            leading={choice && <ProviderIcon agent={choice.agent} />}
            aria-label={accessibleLabel}
            composer
          >
            {label}
          </Chip>
        }
      >
        {lockedReason ? (
          <>
            <p {...stylex.props(text.caption, styles.note)}>{lockedReason}</p>
            <MenuOption selected>{choice?.model || '默认模型'}</MenuOption>
          </>
        ) : (
          <>
            <input
              autoFocus
              aria-label="搜索模型"
              placeholder="搜索模型…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (!['Escape', 'Tab', 'ArrowDown'].includes(event.key)) event.stopPropagation()
              }}
              {...stylex.props(text.small, styles.search)}
            />
            {query && !visibleAgents.some(({ models, matchesAgent }) => models.length > 0 || matchesAgent) && (
              <p {...stylex.props(text.caption, styles.note)}>没有匹配的模型</p>
            )}
            {visibleAgents
              .filter(({ models, matchesAgent }) => !query || models.length > 0 || matchesAgent)
              .map(({ agent, models }) => (
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
                      {models.map((id) => (
                        <MenuOption
                          key={id}
                          leading={<ProviderIcon agent={agent.kind} />}
                          selected={choice?.agent === agent.kind && choice.model === id}
                          onSelect={() => onSelect({ agent: agent.kind, model: id })}
                        >
                          {id || '默认模型'}
                        </MenuOption>
                      ))}
                      {agent.kind !== 'codex' && (
                        <MenuOption
                          onSelect={() => {
                            setModel(choice?.agent === agent.kind ? choice.model : '')
                            setError(null)
                            setCustomAgent(agent)
                          }}
                        >
                          输入模型 ID…
                        </MenuOption>
                      )}
                    </>
                  )}
                </div>
              ))}
          </>
        )}
      </Menu>
      <Dialog
        open={customAgent !== null}
        onOpenChange={(open) => {
          if (!open) setCustomAgent(null)
        }}
        title={`选择 ${customAgent ? agentNames[customAgent.kind] : ''} 模型`}
        actions={
          <>
            <DialogClose render={<Button variant="ghost" />}>取消</DialogClose>
            <Button variant="primary" onClick={selectCustom}>
              使用模型
            </Button>
          </>
        }
      >
        <Field label="模型 ID" error={error}>
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
