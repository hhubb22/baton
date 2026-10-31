import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { agentNames, agentUnavailableReason, canCreateAgent } from '../data/derive'
import type { AgentKind, DeviceAgent } from '../data/types'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, space } from '../theme/tokens.stylex'
import { Chip } from '../ui/Chip'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import cursorMark from '../../../upstream/t3code/apps/marketing/public/harnesses/cursor_light.svg?raw'
import openaiMark from '../../../upstream/t3code/apps/marketing/public/harnesses/openai_dark.svg?raw'

export interface ThreadModelChoice {
  agent: AgentKind
  model: string
}

const styles = stylex.create({
  note: { paddingBlock: '6px', paddingInline: space.sm, color: semantic.mutedForeground },
  providerIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: semantic.mutedForeground,
  },
  pickerShell: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(216px, 1fr)',
    maxHeight: 'min(360px, var(--available-height, 360px))',
  },
  singleShell: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'min(360px, var(--available-height, 360px))',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '104px',
    padding: space.xs,
    backgroundColor: semantic.sidebar,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: semantic.border,
    overflowY: 'auto',
  },
  agentTab: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: '32px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: {
      default: 'transparent',
      ':hover': semantic.accent,
    },
    color: semantic.mutedForeground,
    textAlign: 'left',
    cursor: 'pointer',
    outline: 'none',
    userSelect: 'none',
  },
  agentTabActive: {
    backgroundColor: semantic.accent,
    color: semantic.foreground,
  },
  agentTabUnavailable: {
    color: semantic.faintForeground,
  },
  agentTabName: {
    flexGrow: 1,
    whiteSpace: 'nowrap',
  },
  mainPanel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  },
  search: {
    width: '100%',
    minWidth: 0,
    minHeight: '36px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: semantic.border,
    outline: 'none',
    backgroundColor: 'transparent',
    color: semantic.foreground,
    '::placeholder': { color: semantic.faintForeground },
  },
  modelList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    padding: space.xs,
    overflowY: 'auto',
    flexGrow: 1,
    minHeight: 0,
  },
})

function splitModelId(id: string): { modelLabel: string; prefix?: string } {
  if (!id) return { modelLabel: '默认模型' }
  const slashIndex = id.indexOf('/')
  if (slashIndex <= 0 || slashIndex === id.length - 1) {
    return { modelLabel: id }
  }
  return {
    prefix: id.slice(0, slashIndex),
    modelLabel: id.slice(slashIndex + 1),
  }
}

export function ProviderIcon({ agent }: { agent: AgentKind }) {
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
  if (agent === 'antigravity')
    return (
      <span {...props}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
          <path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" />
        </svg>
      </span>
    )
  if (agent === 'droid')
    return (
      <span {...props}>
        <svg viewBox="0 0 900 900" width="100%" height="100%" fill="currentColor">
          <path d="M622.037 192.524a10.58 10.58 0 0 1-4.056-2.001 10.573 10.573 0 0 1-3.98-7.89 10.595 10.595 0 0 1 .804-4.452c20.214-49.194 29.134-88.555 14.74-105.033-38.123-43.716-191.004 43.219-239.75 72.663a10.596 10.596 0 0 1-10.841.041 10.576 10.576 0 0 1-4.396-5.07c-20.491-49.089-42.031-83.233-63.865-84.714-57.871-3.96-104.516 165.624-118.17 220.895a10.574 10.574 0 0 1-1.993 4.057 10.572 10.572 0 0 1-7.884 3.977 10.586 10.586 0 0 1-4.447-.802c-49.194-20.215-88.572-29.134-105.033-14.74-43.717 38.123 43.202 191.005 72.644 239.75a10.553 10.553 0 0 1 1.454 4.279 10.573 10.573 0 0 1-6.481 10.958c-49.072 20.491-83.216 42.031-84.715 63.864-3.944 57.871 165.624 104.516 220.913 118.171a10.566 10.566 0 0 1 5.658 3.601 10.57 10.57 0 0 1 2.355 6.281 10.58 10.58 0 0 1-.799 4.442c-20.214 49.194-29.134 88.572-14.739 105.033 38.121 43.717 191.021-43.202 239.767-72.644a10.566 10.566 0 0 1 15.238 5.027c20.489 49.072 42.013 83.216 63.862 84.715 57.871 3.944 104.516-165.624 118.153-220.913a10.603 10.603 0 0 1 9.895-8.021 10.566 10.566 0 0 1 4.449.808c49.193 20.214 88.553 29.116 105.032 14.738 43.718-38.121-43.219-191.022-72.663-239.767a10.602 10.602 0 0 1 1.326-12.655 10.604 10.604 0 0 1 3.703-2.582c49.089-20.49 83.233-42.031 84.714-63.863 3.96-57.871-165.624-104.516-220.895-118.153Zm-66.394-55.478c11.123 19.938-46.196 152.797-88.83 245.724a8.36 8.36 0 0 1-8.239 4.855 8.374 8.374 0 0 1-7.412-6.043c-17.219-60.42-36.899-131.411-57.957-191.675a10.557 10.557 0 0 1 4.924-12.759c52.586-28.721 142.568-66.86 157.514-40.102ZM303.635 153.49c21.953 6.233 75.365 140.709 110.92 236.564a8.364 8.364 0 0 1-2.394 9.249 8.364 8.364 0 0 1-9.504.978c-54.943-30.493-119.013-66.824-176.522-94.546a10.565 10.565 0 0 1-5.528-12.501c16.926-57.44 53.532-148.095 83.028-139.744ZM137.064 343.322c19.921-11.123 152.795 46.197 245.707 88.83a8.369 8.369 0 0 1-1.189 15.652c-60.401 17.219-131.411 36.899-191.675 57.957a10.552 10.552 0 0 1-12.742-4.925c-28.668-52.584-66.876-142.568-40.101-157.514Zm16.443 252.009c6.217-21.953 140.709-75.365 236.564-110.921a8.368 8.368 0 0 1 10.227 11.898c-30.511 54.945-66.842 119.014-94.563 176.507a10.548 10.548 0 0 1-5.229 5.075 10.544 10.544 0 0 1-7.271.468c-57.441-16.822-148.095-53.531-139.728-83.027ZM343.34 761.902c-11.14-19.922 46.197-152.796 88.829-245.707a8.383 8.383 0 0 1 5.713-4.66 8.38 8.38 0 0 1 7.182 1.664 8.371 8.371 0 0 1 2.758 4.184c17.217 60.403 36.898 131.412 57.957 191.675a10.558 10.558 0 0 1-4.942 12.743c-52.568 28.668-142.568 66.875-157.445 40.101h-.052Zm252.009-16.443c-21.971-6.216-75.383-140.709-110.939-236.564a8.37 8.37 0 0 1 11.916-10.228c54.926 30.494 119.014 66.842 176.506 94.563a10.538 10.538 0 0 1 5.527 12.502c-16.909 57.526-53.515 148.094-83.01 139.727Zm166.57-189.834c-19.938 11.141-152.796-46.197-245.724-88.83a8.367 8.367 0 0 1-2.993-12.892 8.378 8.378 0 0 1 4.182-2.759c60.419-17.218 131.41-36.899 191.675-57.958a10.577 10.577 0 0 1 12.758 4.943c28.652 52.568 66.86 142.569 40.102 157.496Zm-16.444-252.009c-6.232 21.971-140.709 75.383-236.562 110.94a8.371 8.371 0 0 1-10.229-11.917c30.495-54.926 66.825-119.012 94.547-176.505a10.555 10.555 0 0 1 12.5-5.528c57.441 16.909 148.096 53.516 139.744 83.01Z" />
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
  const [open, setOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | null>(null)
  const [search, setSearch] = useState('')

  const rawModel = search.trim()
  const query = rawModel.toLowerCase()
  const isMultiAgent = agents.length > 1

  const defaultAgent =
    choice?.agent ?? agents.find((agent) => mode !== 'create' || canCreateAgent(agent))?.kind ?? agents[0]?.kind ?? null
  const activeAgentKind =
    selectedAgent && agents.some((agent) => agent.kind === selectedAgent) ? selectedAgent : defaultAgent

  const groups = agents.map((agent) => {
    const unavailable = mode === 'create' && !canCreateAgent(agent)
    const allModels = [
      ...new Set([
        ...(agent.models.length ? agent.models : ['']),
        ...(choice?.agent === agent.kind ? [choice.model] : []),
      ]),
    ]
    const matchesAgent = agentNames[agent.kind].toLowerCase().includes(query)
    const matchingModels = unavailable
      ? []
      : query && !matchesAgent
        ? allModels.filter((id) => {
            const display = id || '默认模型'
            return id.toLowerCase().includes(query) || display.toLowerCase().includes(query)
          })
        : allModels
    return {
      agent,
      unavailable,
      allModels,
      models: matchingModels,
      matchesAgent,
    }
  })

  const activeGroup = groups.find((group) => group.agent.kind === activeAgentKind) ?? groups[0] ?? null
  const orderedGroups = activeGroup
    ? [activeGroup, ...groups.filter((group) => group.agent.kind !== activeGroup.agent.kind)]
    : groups
  const matchedGroups = query
    ? orderedGroups.filter(({ unavailable, models, matchesAgent }) =>
        unavailable ? matchesAgent : models.length > 0 || matchesAgent,
      )
    : activeGroup
      ? [activeGroup]
      : []

  const canTargetCustomModel = Boolean(activeGroup && !activeGroup.unavailable && activeGroup.agent.kind !== 'codex')
  const showCustomModelOption = Boolean(
    rawModel && canTargetCustomModel && activeGroup && !activeGroup.allModels.includes(rawModel),
  )

  const selectAndClose = (next: ThreadModelChoice) => {
    onSelect(next)
    setOpen(false)
    setSearch('')
    setSelectedAgent(null)
  }

  return (
    <Menu
      open={open}
      width={lockedReason ? 'search' : isMultiAgent ? 'picker' : 'modelList'}
      side={side}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setSearch('')
          setSelectedAgent(null)
        }
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
        <div {...stylex.props(isMultiAgent ? styles.pickerShell : styles.singleShell)}>
          {isMultiAgent && (
            <div role="tablist" aria-label="助手" {...stylex.props(styles.sidebar)}>
              {groups.map(({ agent, unavailable }) => {
                const isSelected = activeGroup?.agent.kind === agent.kind
                return (
                  <button
                    key={agent.kind}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setSelectedAgent(agent.kind)}
                    {...stylex.props(
                      isSelected ? text.label13Medium : text.label13,
                      styles.agentTab,
                      unavailable && styles.agentTabUnavailable,
                      isSelected && styles.agentTabActive,
                    )}
                  >
                    <ProviderIcon agent={agent.kind} />
                    <span {...stylex.props(styles.agentTabName)}>{agentNames[agent.kind]}</span>
                  </button>
                )
              })}
            </div>
          )}
          <div {...stylex.props(styles.mainPanel)}>
            <input
              autoFocus
              aria-label="搜索模型"
              placeholder={canTargetCustomModel ? '搜索或输入模型 ID…' : '搜索模型…'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && rawModel) {
                  event.preventDefault()
                  event.stopPropagation()
                  if (activeGroup && !activeGroup.unavailable && activeGroup.allModels.includes(rawModel)) {
                    selectAndClose({ agent: activeGroup.agent.kind, model: rawModel })
                  } else if (showCustomModelOption && activeGroup) {
                    selectAndClose({ agent: activeGroup.agent.kind, model: rawModel })
                  } else {
                    const firstGroup = matchedGroups.find((group) => !group.unavailable && group.models.length > 0)
                    if (firstGroup) {
                      selectAndClose({ agent: firstGroup.agent.kind, model: firstGroup.models[0] })
                    }
                  }
                  return
                }
                if (!['Escape', 'Tab', 'ArrowDown'].includes(event.key)) event.stopPropagation()
              }}
              {...stylex.props(text.small, styles.search)}
            />
            <div {...stylex.props(styles.modelList)}>
              {query && matchedGroups.length === 0 && (
                <p {...stylex.props(text.caption, styles.note)}>没有匹配的模型</p>
              )}
              {matchedGroups.map(({ agent, unavailable, models }) => (
                <div key={agent.kind}>
                  {(!isMultiAgent || query) && <MenuHeading>{agentNames[agent.kind]}</MenuHeading>}
                  {unavailable ? (
                    <MenuOption
                      note={agentUnavailableReason(agent)}
                      onSelect={() => onUnavailable?.(agentUnavailableReason(agent))}
                    >
                      {agentNames[agent.kind]}
                    </MenuOption>
                  ) : (
                    models.map((id) => {
                      const { modelLabel, prefix } = splitModelId(id)
                      return (
                        <MenuOption
                          key={id || '__default'}
                          ariaLabel={id || '默认模型'}
                          leading={isMultiAgent && query ? <ProviderIcon agent={agent.kind} /> : undefined}
                          note={prefix}
                          selected={choice?.agent === agent.kind && choice.model === id}
                          onSelect={() => selectAndClose({ agent: agent.kind, model: id })}
                        >
                          {modelLabel}
                        </MenuOption>
                      )
                    })
                  )}
                </div>
              ))}
              {showCustomModelOption && activeGroup && (
                <>
                  {matchedGroups.length > 0 && <MenuRule />}
                  <MenuOption
                    ariaLabel={`使用 ${rawModel}`}
                    leading={<ProviderIcon agent={activeGroup.agent.kind} />}
                    note={isMultiAgent ? `${agentNames[activeGroup.agent.kind]} · 自定义模型` : '自定义模型'}
                    onSelect={() => selectAndClose({ agent: activeGroup.agent.kind, model: rawModel })}
                  >
                    {`使用「${rawModel}」`}
                  </MenuOption>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Menu>
  )
}
