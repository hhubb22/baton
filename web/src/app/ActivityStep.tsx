import * as stylex from '@stylexjs/stylex'
import { lazy, Suspense, type ReactNode } from 'react'
import { baseName, fileSize } from '../data/derive'
import type { Device, TraceStep } from '../data/types'
import { fonts, fontSize } from '../theme/base.stylex'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Icon, type IconName } from '../ui/Icon'
import { FullOutput } from './FullOutput'

const ChangeDiff = lazy(() => import('./ChangeDiff').then((module) => ({ default: module.ChangeDiff })))

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space.xs, alignSelf: 'stretch', minWidth: 0 },
  head: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px', color: semantic.mutedForeground },
  label: { overflowWrap: 'anywhere', minWidth: 0 },
  output: {
    margin: 0,
    maxHeight: '240px',
    overflow: 'auto',
    paddingLeft: space.md,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: semantic.border,
    fontFamily: fonts.mono,
    fontSize: fontSize.caption,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  muted: { color: semantic.mutedForeground },
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
        label: string(data.input) ?? title ?? '命令',
        icon: 'terminal',
        body: (
          <>
            {string(data.encoding) && data.encoding !== 'utf8' && (
              <span {...stylex.props(text.caption, styles.muted)}>
                输出编码： {data.encoding === 'base64' ? 'Base64' : String(data.encoding)}
              </span>
            )}
            <Output label={data.encoding === 'base64' ? 'Base64 编码的命令输出' : '命令输出'} value={data.output} />
            {typeof data.exitCode === 'number' && (
              <span {...stylex.props(text.caption, styles.muted)}>退出码 {data.exitCode}</span>
            )}
          </>
        ),
      }
    case 'dynamic_tool':
      return {
        label: title ?? string(data.toolName) ?? '工具调用',
        icon: 'tool',
        body: (
          <>
            {string(data.nativeToolId) && (
              <span {...stylex.props(text.caption, styles.muted)}>{String(data.nativeToolId)}</span>
            )}
            {outputText(data.input) !== undefined && <span {...stylex.props(text.caption, styles.muted)}>输入</span>}
            <Output label="工具输入" value={data.input} />
            {outputText(data.output) !== undefined && <span {...stylex.props(text.caption, styles.muted)}>结果</span>}
            <Output label="工具输出" value={data.output} />
          </>
        ),
      }
    case 'file_change': {
      const path = string(data.fileName)
      return {
        label: title ?? (path ? `已更改 ${baseName(path)}` : '文件更改'),
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
            {typeof data.diffStr === 'string' ? (
              <Suspense fallback={<Output label="文件改动" value={data.diffStr} />}>
                <ChangeDiff
                  patch={data.diffStr}
                  path={path}
                  fallback={<Output label="文件改动" value={data.diffStr} />}
                />
              </Suspense>
            ) : (
              <Output
                label="文件改动"
                value={
                  data.changes ??
                  (data.oldStr !== undefined || data.newStr !== undefined
                    ? { before: data.oldStr, after: data.newStr }
                    : undefined)
                }
              />
            )}
          </>
        ),
      }
    }
    case 'reasoning':
      return { label: title ?? '思考过程', icon: 'reasoning', body: <Output label="思考过程" value={data.text} /> }
    case 'proposed_plan':
      return { label: title ?? '计划', icon: 'tasks', body: <Output label="计划" value={data.markdown} /> }
    case 'todo_list':
      return {
        label: title ?? '计划',
        icon: 'tasks',
        body: (
          <>
            <Output label="计划说明" value={data.explanation} />
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
        label: title ?? (step.type === 'file_search' ? '文件搜索' : '网页搜索'),
        icon: step.type === 'file_search' ? 'file-search' : 'web-search',
        body: (
          <>
            <Output label="搜索内容" value={data.pattern ?? data.patterns} />
            <Output label="搜索结果" value={data.results} />
          </>
        ),
      }
    case 'approval_request':
    case 'user_input_request':
      return {
        label: title ?? '问题',
        icon: 'message',
        body: <Output label="问题" value={data.prompt ?? data.questions ?? step.data} />,
      }
    case 'subagent':
      return {
        label: title ?? '助手任务',
        icon: 'subagent',
        body: (
          <>
            <Output label="任务内容" value={data.prompt} />
            <Output label="任务进度" value={data.progress} />
            <Output label="任务结果" value={data.result ?? undefined} />
          </>
        ),
      }
    case 'error':
      return {
        label: title ?? '错误',
        icon: 'alert',
        body: (
          <>
            <Output label="错误详情" value={data.failure} />
            <Output label="重试详情" value={data.retry} />
          </>
        ),
      }
    case 'token_usage':
      return { label: title ?? 'Token 用量', icon: 'usage', body: <Output label="Token 用量" value={step.data} /> }
    case 'notification':
    case 'system_notice':
      return {
        label: title ?? string(data.title) ?? '提示',
        icon: 'message',
        body: <Output label="提示" value={data.message ?? data.detail ?? step.data} />,
      }
    case 'compaction':
      return {
        label: title ?? '上下文摘要',
        icon: 'memory',
        body: <Output label="上下文摘要" value={data.summary ?? step.data} />,
      }
    default:
      return {
        label: title ?? statusLabel(step.type),
        icon: 'dots',
        body: <Output label="执行详情" value={step.data} />,
      }
  }
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: '等待中',
    running: '运行中',
    in_progress: '进行中',
    completed: '已完成',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    stopped: '已停止',
    added: '已添加',
    modified: '已修改',
    deleted: '已删除',
  }
  return Object.hasOwn(labels, status) ? labels[status]! : status
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
  const times = [step.started_at && `开始：${step.started_at}`, step.completed_at && `结束：${step.completed_at}`]
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
          <span title={`${step.original_bytes} 字节`} {...stylex.props(text.caption, styles.muted)}>
            原始大小 {fileSize(step.original_bytes)}，内容已截断
            {step.full_output && device?.connection !== 'online' && ` · 完整输出保存在 ${device?.name ?? '原设备'}`}
          </span>
          {step.full_output ? (
            <FullOutput threadId={threadId} reference={step.full_output} />
          ) : (
            <span {...stylex.props(text.caption, styles.muted)}>此步骤的其余内容不可用。</span>
          )}
        </>
      )}
    </div>
  )
}
