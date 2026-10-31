import type { RuntimeMode } from '@baton/protocol'
import * as stylex from '@stylexjs/stylex'
import { useState, type KeyboardEvent } from 'react'
import { agentNames, agentUnavailableReason, canCreateAgent } from '../data/derive'
import type { AgentKind, Device, DeviceAgent } from '../data/types'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, space } from '../theme/tokens.stylex'
import { Tag } from '../ui/Badge'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { StatusChip, StatusDot } from '../ui/Status'
import { ProviderIcon } from './ThreadModelMenu'

const runtimeModeNames: Record<RuntimeMode, string> = {
  'approval-required': 'Supervised',
  'auto-accept-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
}

const styles = stylex.create({
  split: {
    display: 'grid',
    gridTemplateColumns: '176px minmax(0, 1fr)',
    minHeight: '340px',
    maxHeight: '460px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.card,
    overflow: 'hidden',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: space.xs,
    backgroundColor: semantic.sidebar,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: semantic.border,
    overflowY: 'auto',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.mutedForeground,
    textAlign: 'left',
  },
  tabActive: {
    backgroundColor: { default: semantic.accent, ':hover': semantic.accent },
    color: semantic.foreground,
  },
  tabInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
    flexGrow: 1,
  },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    padding: space.lg,
    minWidth: 0,
    overflowY: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
  },
  diagnostic: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: semantic.sidebar,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
  },
  attention: { color: semantic.warningForeground },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    minWidth: 0,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: { default: semantic.border, ':last-child': 'transparent' },
  },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    flexShrink: 0,
  },
})

function agentShortStatus(agent: DeviceAgent): {
  label: string
  tone: 'success' | 'hollow' | 'attention'
} {
  if (canCreateAgent(agent)) {
    const version = agent.version ? `v${agent.version.replace(/^v/, '')}` : '可用'
    return { label: version, tone: 'success' }
  }
  if (agent.status === 'unverified') return { label: '未验证', tone: 'hollow' }
  if (agent.problem === 'notInstalled') return { label: '未安装', tone: 'attention' }
  if (agent.problem === 'signedOut') return { label: '未登录', tone: 'attention' }
  return { label: '需要处理', tone: 'attention' }
}

function agentStatusBadge(agent: DeviceAgent): {
  label: string
  tone: 'success' | 'hollow' | 'attention'
} {
  if (canCreateAgent(agent)) return { label: '可用', tone: 'success' }
  if (agent.status === 'unverified') return { label: '未验证', tone: 'hollow' }
  if (agent.problem === 'notInstalled') return { label: '未安装', tone: 'attention' }
  if (agent.problem === 'signedOut') return { label: '需要登录', tone: 'attention' }
  return { label: '需要处理', tone: 'attention' }
}

function agentSetupGuide(agent: DeviceAgent, deviceName: string): string {
  switch (agent.kind) {
    case 'codex':
      return `在 ${deviceName} 上安装 Codex CLI 并运行 codex login 登录 ChatGPT。`
    case 'cursor':
      return `在 ${deviceName} 上配置 CURSOR_API_KEY，或运行 cursor-agent login 登录。`
    case 'kiro':
      return `在 ${deviceName} 上安装 kiro-cli 并完成账号登录。`
    case 'pi':
      return `在 ${deviceName} 上安装 Pi CLI 并完成账号登录。`
    case 'antigravity':
      return `在 ${deviceName} 上安装 agy 并完成账号登录。`
    case 'droid':
      return `在 ${deviceName} 上运行 droid 登录，或配置 FACTORY_API_KEY。`
  }
}

function abilityLabels(agent: DeviceAgent): string[] {
  const result: string[] = []
  if (agent.abilities.create) result.push('新建对话')
  if (agent.abilities.resume) result.push('恢复对话')
  if (agent.abilities.queue) result.push('排队发送')
  if (agent.abilities.steer) result.push('立即插话')
  if (agent.abilities.switchModel) result.push('中途换模型')
  return result
}

export function DeviceAgentsPanel({
  agents,
  deviceName = '此设备',
  initialAgent,
}: {
  agents: DeviceAgent[]
  deviceName?: string
  initialAgent?: AgentKind
}) {
  const [selectedKind, setSelectedKind] = useState<AgentKind | null>(() => {
    if (initialAgent && agents.some((item) => item.kind === initialAgent)) return initialAgent
    const broken = agents.find((item) => !canCreateAgent(item))
    return (broken ?? agents[0])?.kind ?? null
  })

  if (agents.length === 0) {
    return <p {...stylex.props(text.small, text.muted)}>此设备尚未报告编码 Agent。</p>
  }

  const active = agents.find((item) => item.kind === selectedKind) ?? agents[0]!
  const badge = agentStatusBadge(active)
  const usable = canCreateAgent(active)
  const abilities = abilityLabels(active)
  const modes = active.runtimeModes ?? []

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const index = agents.findIndex((item) => item.kind === active.kind)
    let next = index
    if (event.key === 'ArrowDown') next = (index + 1) % agents.length
    else if (event.key === 'ArrowUp') next = (index - 1 + agents.length) % agents.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = agents.length - 1
    const target = agents[next]
    if (target) setSelectedKind(target.kind)
  }

  return (
    <div {...stylex.props(styles.split)}>
      <div role="tablist" aria-label="编码 Agent" onKeyDown={onTabKeyDown} {...stylex.props(styles.sidebar)}>
        {agents.map((agent) => {
          const isSelected = agent.kind === active.kind
          const status = agentShortStatus(agent)
          return (
            <button
              key={agent.kind}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelectedKind(agent.kind)}
              {...stylex.props(styles.tab, isSelected && styles.tabActive, focusRing.ring)}
            >
              <ProviderIcon agent={agent.kind} />
              <span {...stylex.props(styles.tabInfo)}>
                <span {...stylex.props(text.small, text.truncate)}>{agentNames[agent.kind]}</span>
                <span
                  {...stylex.props(
                    text.caption,
                    text.truncate,
                    status.tone === 'attention' ? styles.attention : text.muted,
                  )}
                >
                  {status.label}
                </span>
              </span>
              <StatusDot tone={status.tone} />
            </button>
          )
        })}
      </div>

      <div role="tabpanel" aria-label={agentNames[active.kind]} {...stylex.props(styles.detail)}>
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            <ProviderIcon agent={active.kind} />
            <span {...stylex.props(text.heading)}>{agentNames[active.kind]}</span>
            {active.version && (
              <span {...stylex.props(text.mono, text.caption, text.muted)}>v{active.version.replace(/^v/, '')}</span>
            )}
          </div>
          <StatusChip tone={badge.tone} label={badge.label} />
        </div>

        {(!usable || active.reason) && (
          <div role="status" {...stylex.props(styles.diagnostic)}>
            <span {...stylex.props(text.small, !usable ? styles.attention : text.muted)}>
              {!usable ? agentUnavailableReason(active) : active.reason}
            </span>
            {!usable && <span {...stylex.props(text.caption, text.muted)}>{agentSetupGuide(active, deviceName)}</span>}
          </div>
        )}

        <div {...stylex.props(styles.section)}>
          <span {...stylex.props(text.label)}>支持能力</span>
          {abilities.length > 0 ? (
            <div {...stylex.props(styles.tags)}>
              {active.account && <Tag>账号：{active.account}</Tag>}
              {abilities.map((label) => (
                <Tag key={label}>{label}</Tag>
              ))}
            </div>
          ) : (
            <span {...stylex.props(text.small, text.muted)}>当前不可用</span>
          )}
        </div>

        <div {...stylex.props(styles.section)}>
          <span {...stylex.props(text.label)}>执行权限</span>
          {modes.length > 0 ? (
            <div {...stylex.props(styles.list)}>
              {modes.map((mode) => (
                <div key={mode.id} {...stylex.props(styles.listRow)}>
                  <span {...stylex.props(text.small)}>{runtimeModeNames[mode.id]}</span>
                  <span {...stylex.props(styles.rowMeta)}>
                    {mode.id === active.defaultRuntimeMode && <Tag>默认</Tag>}
                    <span {...stylex.props(text.caption, mode.available ? text.muted : styles.attention)}>
                      {mode.available ? '可用' : (mode.reason ?? '不可用')}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span {...stylex.props(text.small, text.muted)}>使用助手默认执行权限。</span>
          )}
        </div>

        <div {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHeader)}>
            <span {...stylex.props(text.label)}>可用模型</span>
            {active.models.length > 0 && (
              <span {...stylex.props(text.caption, text.muted)}>{active.models.length} 个</span>
            )}
          </div>
          {active.models.length > 0 ? (
            <div {...stylex.props(styles.list)}>
              {active.models.map((model) => (
                <div key={model} {...stylex.props(styles.listRow)}>
                  <span {...stylex.props(text.mono, text.small, text.truncate)}>{model}</span>
                  <span {...stylex.props(styles.rowMeta)}>
                    {model === active.defaultModel && <Tag>默认</Tag>}
                    {(active.modelThinking?.[model]?.options.length ?? 0) > 0 && <Tag>思考档位</Tag>}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span {...stylex.props(text.small, text.muted)}>
              {usable ? '使用助手默认模型。' : '完成安装和登录后显示可用模型。'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function DeviceAgentsDialog({
  device,
  initialAgent,
  onClose,
}: {
  device: Device
  initialAgent?: AgentKind
  onClose: () => void
}) {
  const usableCount = device.agents.filter(canCreateAgent).length
  const brokenCount = device.agents.length - usableCount
  const description =
    device.agents.length === 0
      ? '查看此设备上探测到的编码 Agent。'
      : brokenCount > 0
        ? `${usableCount} 个可用 · ${brokenCount} 个需要处理`
        : `${usableCount} 个编码 Agent 全部可用`
  return (
    <Dialog
      open
      split
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`${device.name} 上的编码 Agent`}
      description={description}
      actions={<Button onClick={onClose}>完成</Button>}
    >
      <DeviceAgentsPanel agents={device.agents} deviceName={device.name} initialAgent={initialAgent} />
    </Dialog>
  )
}
