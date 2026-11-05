import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { subscriptionCredentialIssue } from '../data/derive'
import { useClient } from '../data/queries'
import type { Device, ID, ModelConnection, Subscription } from '../data/types'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, space } from '../theme/tokens.stylex'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Menu, MenuOption } from '../ui/Menu'
import { Toggle } from '../ui/Toggle'
import { ModelConnectionEditor } from './ModelConnectionEditor'
import { SubscriptionLoginDialog } from './SubscriptionLoginDialog'

export type PermissionState = { deviceId: ID; phase: 'saving' | 'saved' | 'failed'; enabled: boolean }

const connectionProtocol = {
  'openai-responses': 'OpenAI Responses',
  'openai-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
} as const

function connectionHost(value: string) {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    minWidth: 0,
  },
  sourceHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.md,
    backgroundColor: semantic.card,
  },
  sourceRow: {
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
  sourceInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    minWidth: 0,
  },
  permission: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.lg,
    padding: space.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.md,
    backgroundColor: semantic.card,
  },
  permissionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    flexGrow: 1,
  },
  attention: { color: semantic.warningForeground },
})

function subscriptionStatusDetail(sub: Subscription): { text: string; attention: boolean } {
  const issue = subscriptionCredentialIssue(sub)
  if (issue) return { text: issue, attention: true }
  if (sub.signedIn) {
    const modelNote = sub.models && sub.models.length > 0 ? ` · ${sub.models.length} 个模型` : ''
    return { text: `已登录${modelNote}`, attention: false }
  }
  if (sub.status === 'unknown') return { text: '无法检查登录状态 · 可以尝试', attention: false }
  return { text: '未登录', attention: false }
}

function CommandPermission({
  state,
  enabled,
  onChange,
}: {
  state: PermissionState | undefined
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  let line: { text: string; warning?: boolean } | null = null
  if (state?.phase === 'saving') line = { text: '正在保存命令权限…' }
  else if (state?.phase === 'saved') line = { text: '已保存' }
  else if (state?.phase === 'failed') {
    line = {
      warning: true,
      text: state.enabled ? '保存失败，命令执行仍处于关闭状态。' : '保存失败，命令执行仍处于允许状态。',
    }
  }
  return (
    <section aria-label="命令权限" {...stylex.props(styles.permission)}>
      <div {...stylex.props(styles.permissionText)}>
        <span {...stylex.props(text.label)}>允许项目助手运行命令</span>
        <span {...stylex.props(text.caption, text.muted)}>以设备用户身份运行，可访问目录外的文件。</span>
        {line && (
          <span role="status" {...stylex.props(text.caption, line.warning ? styles.attention : text.muted)}>
            {line.text}
          </span>
        )}
      </div>
      <Toggle
        label="允许项目助手运行命令"
        checked={enabled}
        onChange={(next) => {
          if (state?.phase !== 'saving') onChange(next)
        }}
      />
    </section>
  )
}

export function ProjectAssistantDialog({
  device,
  permission,
  onSavePermission,
  onClose,
}: {
  device: Device
  permission: PermissionState | undefined
  onSavePermission: (enabled: boolean) => void
  onClose: () => void
}) {
  const client = useClient()
  const [loginProvider, setLoginProvider] = useState<{ provider: string; localOnly: boolean } | null>(null)
  const [editing, setEditing] = useState<ModelConnection | 'new' | null>(null)
  const [confirmingCommand, setConfirmingCommand] = useState(false)
  const [logoutError, setLogoutError] = useState(false)
  const connected = device.connection === 'online'
  const connections = device.modelConnections ?? []

  if (loginProvider) {
    return (
      <SubscriptionLoginDialog
        device={device}
        provider={loginProvider.provider}
        localOnly={loginProvider.localOnly}
        finalFocus={false}
        onClose={() => setLoginProvider(null)}
      />
    )
  }

  if (confirmingCommand) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setConfirmingCommand(false)
        }}
        title={`允许项目助手在 ${device.name} 上运行命令？`}
        description={`命令以 ${device.commandAccess.user || '当前用户'} 的身份直接运行，可以访问所选文件夹以外的文件。`}
        finalFocus={false}
        actions={
          <>
            <Button onClick={() => setConfirmingCommand(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                onSavePermission(true)
                setConfirmingCommand(false)
              }}
            >
              允许执行命令
            </Button>
          </>
        }
      />
    )
  }

  if (editing) {
    return (
      <Dialog
        open
        wide
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
        title={`${device.name} 上的项目助手`}
      >
        <ModelConnectionEditor
          device={device}
          initial={editing === 'new' ? undefined : editing}
          onBack={() => setEditing(null)}
        />
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`${device.name} 上的项目助手`}
      description={
        device.hasRuntime
          ? '配置项目助手在此设备上使用的订阅、API 连接与命令权限。'
          : '此设备尚未安装项目助手，请重新安装 Baton。'
      }
      actions={<Button onClick={onClose}>完成</Button>}
    >
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.group)}>
          <span {...stylex.props(text.label)}>订阅</span>
          {device.subscriptions.length > 0 ? (
            <div {...stylex.props(styles.list)}>
              {device.subscriptions.map((sub) => {
                const canLogin = connected && sub.loginMethods?.includes('oauth')
                const detail = subscriptionStatusDetail(sub)
                return (
                  <div key={sub.provider} {...stylex.props(styles.sourceRow)}>
                    <div {...stylex.props(styles.sourceInfo)}>
                      <span {...stylex.props(text.small)}>{sub.provider}</span>
                      <span {...stylex.props(text.caption, detail.attention ? styles.attention : text.muted)}>
                        {detail.text}
                      </span>
                    </div>
                    {!sub.signedIn && canLogin && (
                      <Button
                        small
                        aria-label={`登录 ${sub.provider}`}
                        onClick={() => setLoginProvider({ provider: sub.provider, localOnly: false })}
                      >
                        登录
                      </Button>
                    )}
                    {sub.signedIn && connected && (
                      <Menu align="end" trigger={<IconButton icon="dots" label={`管理 ${sub.provider}`} />}>
                        {canLogin && (
                          <MenuOption onSelect={() => setLoginProvider({ provider: sub.provider, localOnly: false })}>
                            重新登录
                          </MenuOption>
                        )}
                        <MenuOption
                          onSelect={() => {
                            setLogoutError(false)
                            void client
                              .logoutSubscription({ deviceId: device.id, provider: sub.providerId ?? sub.provider })
                              .catch(() => setLogoutError(true))
                          }}
                        >
                          退出登录
                        </MenuOption>
                      </Menu>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <span {...stylex.props(text.caption, text.muted)}>暂无可用订阅。</span>
          )}
          {logoutError && (
            <p role="alert" {...stylex.props(text.small, styles.attention)}>
              无法退出登录，请重试。
            </p>
          )}
        </div>

        <div {...stylex.props(styles.group)}>
          <div {...stylex.props(styles.sourceHeading)}>
            <span {...stylex.props(text.label)}>API 连接</span>
            <Button small onClick={() => setEditing('new')}>
              添加连接
            </Button>
          </div>
          {connections.length > 0 ? (
            <div {...stylex.props(styles.list)}>
              {connections.map((connection) => (
                <div key={connection.id} {...stylex.props(styles.sourceRow)}>
                  <div {...stylex.props(styles.sourceInfo)}>
                    <span {...stylex.props(text.small)}>{connection.name}</span>
                    <span {...stylex.props(text.caption, text.muted)}>
                      {connectionProtocol[connection.protocol]} · {connectionHost(connection.base_url)}
                      {connection.keyNeeded ? ' · 需要密钥' : ''}
                    </span>
                  </div>
                  <Button small aria-label={`编辑 ${connection.name}`} onClick={() => setEditing(connection)}>
                    编辑
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <span {...stylex.props(text.caption, text.muted)}>尚未添加自定义 API 连接。</span>
          )}
        </div>

        {connected && device.hasRuntime && (
          <CommandPermission
            state={permission}
            enabled={device.commandAccess.enabled}
            onChange={(next) => {
              if (next) setConfirmingCommand(true)
              else onSavePermission(false)
            }}
          />
        )}
      </div>
    </Dialog>
  )
}
