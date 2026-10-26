import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { baseName, fileSize } from '../data/derive'
import type { Device, TraceStep } from '../data/types'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Icon, type IconName } from '../ui/Icon'
import { FullOutput } from './FullOutput'

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space.xs, alignSelf: 'stretch', minWidth: 0 },
  head: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px', color: colors.muted },
  label: { overflowWrap: 'anywhere', minWidth: 0 },
  output: {
    margin: 0,
    maxHeight: '240px',
    overflow: 'auto',
    paddingLeft: space.md,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  muted: { color: colors.muted },
  list: { display: 'flex', flexDirection: 'column', gap: space.xs, paddingLeft: space.lg, margin: 0 },
})

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// 上游工具的文本块保留换行，其他 JSON 内容以原结构显示。
function outputText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value || undefined
  if (
    Array.isArray(value) &&
    value.every((part) => record(part).type === 'text' && typeof record(part).text === 'string')
  )
    return value.map((part) => record(part).text).join('\n')
  return JSON.stringify(value, null, 2)
}

function Output({ value, label }: { value: unknown; label: string }) {
  const content = outputText(value)
  return content === undefined ? null : (
    <pre aria-label={label} tabIndex={0} {...stylex.props(styles.output)}>
      {content}
    </pre>
  )
}

function presentation(step: TraceStep): { label: string; icon: IconName; body: ReactNode } {
  const data = record(step.data)
  const title = step.title
  switch (step.type) {
    case 'command_execution':
      return {
        label: string(data.input) ?? title ?? 'Command',
        icon: 'terminal',
        body: (
          <>
            {string(data.encoding) && data.encoding !== 'utf8' && (
              <span {...stylex.props(text.caption, styles.muted)}>
                Output encoding: {data.encoding === 'base64' ? 'Base64' : String(data.encoding)}
              </span>
            )}
            <Output
              label={data.encoding === 'base64' ? 'Base64-encoded command output' : 'Command output'}
              value={data.output}
            />
            {typeof data.exitCode === 'number' && (
              <span {...stylex.props(text.caption, styles.muted)}>exit {data.exitCode}</span>
            )}
          </>
        ),
      }
    case 'dynamic_tool':
      return {
        label: title ?? string(data.toolName) ?? 'Tool call',
        icon: 'settings',
        body: (
          <>
            <Output label="Tool input" value={data.input} />
            <Output label="Tool output" value={data.output} />
          </>
        ),
      }
    case 'file_change': {
      const path = string(data.fileName)
      return {
        label: title ?? (path ? `Changed ${baseName(path)}` : 'File changes'),
        icon: 'file',
        body: (
          <>
            {path && <span {...stylex.props(text.caption, styles.muted)}>{path}</span>}
            {(typeof data.additions === 'number' || typeof data.deletions === 'number') && (
              <span {...stylex.props(text.caption, styles.muted)}>
                {typeof data.additions === 'number' ? `+${data.additions}` : ''}{' '}
                {typeof data.deletions === 'number' ? `−${data.deletions}` : ''}
              </span>
            )}
            <Output
              label="File changes"
              value={
                data.diffStr ??
                data.changes ??
                (data.oldStr !== undefined || data.newStr !== undefined
                  ? { before: data.oldStr, after: data.newStr }
                  : undefined)
              }
            />
          </>
        ),
      }
    }
    case 'reasoning':
      return { label: title ?? 'Reasoning', icon: 'sparkle', body: <Output label="Reasoning" value={data.text} /> }
    case 'proposed_plan':
      return { label: title ?? 'Plan', icon: 'tasks', body: <Output label="Plan" value={data.markdown} /> }
    case 'todo_list':
      return {
        label: title ?? 'Plan',
        icon: 'tasks',
        body: (
          <>
            <Output label="Plan notes" value={data.explanation} />
            {Array.isArray(data.steps) && (
              <ol {...stylex.props(text.small, styles.list)}>
                {data.steps.map((item, index) => {
                  const entry = record(item)
                  return (
                    <li key={index}>
                      {string(entry.text) ?? outputText(item)}
                      {string(entry.status) && ` · ${statusLabel(String(entry.status))}`}
                    </li>
                  )
                })}
              </ol>
            )}
          </>
        ),
      }
    case 'file_search':
    case 'web_search':
      return {
        label: title ?? (step.type === 'file_search' ? 'File search' : 'Web search'),
        icon: 'folder',
        body: (
          <>
            <Output label="Search query" value={data.pattern ?? data.patterns} />
            <Output label="Search results" value={data.results} />
          </>
        ),
      }
    case 'approval_request':
    case 'user_input_request':
      return {
        label: title ?? 'Question',
        icon: 'message',
        body: <Output label="Question" value={data.prompt ?? data.questions ?? step.data} />,
      }
    case 'subagent':
      return {
        label: title ?? 'Assistant task',
        icon: 'sparkle',
        body: (
          <>
            <Output label="Task prompt" value={data.prompt} />
            <Output label="Task progress" value={data.progress} />
            <Output label="Task result" value={data.result ?? undefined} />
          </>
        ),
      }
    case 'error':
      return {
        label: title ?? 'Error',
        icon: 'alert',
        body: (
          <>
            <Output label="Error details" value={data.failure} />
            <Output label="Retry details" value={data.retry} />
          </>
        ),
      }
    case 'token_usage':
      return { label: title ?? 'Token usage', icon: 'dots', body: <Output label="Token usage" value={step.data} /> }
    case 'notification':
    case 'system_notice':
      return {
        label: title ?? string(data.title) ?? 'Notice',
        icon: 'message',
        body: <Output label="Notice" value={data.message ?? data.detail ?? step.data} />,
      }
    case 'compaction':
      return {
        label: title ?? 'Context summary',
        icon: 'memory',
        body: <Output label="Context summary" value={data.summary ?? step.data} />,
      }
    default:
      return {
        label: title ?? statusLabel(step.type),
        icon: 'dots',
        body: <Output label="Activity details" value={step.data} />,
      }
  }
}

function statusLabel(status: string) {
  const label = status.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function ActivityStep({
  step,
  threadId,
  device,
}: {
  step: TraceStep
  threadId: string
  device: Device | undefined
}) {
  const view = presentation(step)
  const times = [step.started_at && `Started ${step.started_at}`, step.completed_at && `Finished ${step.completed_at}`]
    .filter(Boolean)
    .join('\n')
  const data = record(step.data)
  return (
    <div {...stylex.props(styles.root)}>
      <div title={times || undefined} {...stylex.props(text.small, styles.head)}>
        <Icon name={view.icon} size={12} />
        <span {...stylex.props(styles.label, step.type === 'command_execution' && text.mono)}>{view.label}</span>
        {step.status && !(step.type === 'command_execution' && typeof data.exitCode === 'number') && (
          <span {...stylex.props(text.caption)}>{statusLabel(step.status)}</span>
        )}
      </div>
      {view.body}
      {step.truncated && (
        <>
          <span title={`${step.original_bytes} bytes`} {...stylex.props(text.caption, styles.muted)}>
            Truncated from {fileSize(step.original_bytes)}
            {step.full_output &&
              device?.connection !== 'online' &&
              ` · full output on ${device?.name ?? 'the original device'}`}
          </span>
          {step.full_output ? (
            <FullOutput threadId={threadId} reference={step.full_output} />
          ) : (
            <span {...stylex.props(text.caption, styles.muted)}>The rest of this step is unavailable.</span>
          )}
        </>
      )}
    </div>
  )
}
