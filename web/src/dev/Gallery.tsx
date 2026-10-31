// 组件画廊：查看全部组件的状态，用面板调节 base、accent、contrast、圆角和字体。入口是开发环境的 ?gallery=1。
import * as stylex from '@stylexjs/stylex'
import { useEffect, useState, type ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { defaultInputs, type ThemeInputs } from '../theme/generate'
import { applyThemeInputs, useTheme, type ThemeMode } from '../theme/ThemeProvider'
import { text } from '../theme/text'
import { radius, space } from '../theme/tokens.stylex'
import { AgentMark, PersonAvatar } from '../ui/Avatar'
import { Count, Tag, UnreadDot } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { branch } from '../ui/Branch'
import { Button, IconButton } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CommandDialog } from '../ui/Command'
import { Composer as PageComposer } from '../ui/Composer'
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerItem,
  ComposerList,
  ComposerPopup,
  ComposerStatus,
  ComposerSubmit,
  type ComposerItemValue,
} from '../ui/composer-editor'
import { Dialog } from '../ui/Dialog'
import { Field, Input, TextArea } from '../ui/Field'
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from '../ui/Frame'
import { Icon } from '../ui/Icon'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { Select } from '../ui/Select'
import { StatusChip, StatusDot, StatusPill, type Tone } from '../ui/Status'
import { Segmented, Tabs } from '../ui/Tabs'
import { Toggle } from '../ui/Toggle'
import { threadStatusTones } from '../data/derive'
import { ThreadStatusIcon, type ThreadStatus } from '../ui/ThreadStatusIcon'
import { Tooltip } from '../ui/Tooltip'

const styles = stylex.create({
  page: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 280px',
    height: '100%',
    backgroundColor: semantic.background,
    color: semantic.foreground,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.section,
    minWidth: 0,
    padding: space.section,
    overflowY: 'auto',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    padding: space.lg,
    overflowY: 'auto',
    backgroundColor: semantic.sidebar,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: semantic.border,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space.md },
  sectionTitle: { color: semantic.mutedForeground },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  stack: { display: 'flex', flexDirection: 'column', gap: space.md, maxWidth: '640px' },
  swatches: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: space.sm },
  swatch: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    color: semantic.mutedForeground,
    fontSize: '12px',
  },
  chip: {
    flexShrink: 0,
    width: '20px',
    height: '20px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.sm,
  },
  slider: { display: 'flex', flexDirection: 'column', gap: space.xs },
  sliderHead: { display: 'flex', justifyContent: 'space-between', color: semantic.mutedForeground, fontSize: '12px' },
  range: { width: '100%' },
  prose: { maxWidth: '65ch' },
  code: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: semantic.code,
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  added: { color: semantic.successForeground },
  removed: { color: semantic.destructiveForeground },
  muted: { color: semantic.mutedForeground },
  faint: { color: semantic.faintForeground },
  settingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.lg },
  statusLegend: { display: 'inline-flex', alignItems: 'center', gap: space.xs },
  threadList: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  threadListSample: { maxWidth: '640px' },
  threadGroup: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    backgroundColor: semantic.muted,
    color: semantic.mutedForeground,
  },
  threadRow: { display: 'flex', alignItems: 'center', gap: space.sm, height: '36px', paddingInline: space.sm },
  threadUnreadTitle: { fontWeight: 500 },
  threadTitle: { flexGrow: 1, minWidth: 0 },
  threadUnreadSlot: { display: 'inline-flex', justifyContent: 'center', flexShrink: 0, width: '16px' },
  threadTime: { flexShrink: 0, color: semantic.mutedForeground, fontVariantNumeric: 'tabular-nums' },
  compactStatus: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
})

const swatchNames = [
  'background',
  'card',
  'popover',
  'sidebar',
  'secondary',
  'muted',
  'accent',
  'border',
  'input',
  'ring',
  'primary',
  'brand',
  'brandSoft',
  'destructive',
  'destructiveSoft',
  'warning',
  'warningSoft',
  'success',
  'successSoft',
  'info',
  'infoSoft',
  'agent',
  'agentSoft',
  'inverse',
  'code',
] as const

const tones: Tone[] = ['info', 'neutral', 'hollow', 'success', 'danger', 'attention', 'agent']

const fontChoices = [
  { value: 'geist', label: 'Geist', family: null },
  { value: 'serif', label: 'Geist Serif', family: 'var(--font-serif)' },
  { value: 'mono', label: 'Geist Mono', family: 'var(--font-mono)' },
] as const

const radiusScales = [
  { value: 'tight', label: '紧 Tight', scale: 0.5 },
  { value: 'normal', label: '默认 Default', scale: 1 },
  { value: 'round', label: '圆 Round', scale: 1.5 },
] as const

const threadStatuses: { status: ThreadStatus; label: string }[] = [
  { status: 'running', label: '运行中' },
  { status: 'attention', label: '需要你处理' },
  { status: 'stopped', label: '已停止' },
  { status: 'waiting', label: '等待设备' },
  { status: 'idle', label: '空闲' },
  { status: 'archived', label: '已归档' },
]

const threadSample: { group: string; status: ThreadStatus; rows: { title: string; unread?: boolean }[] }[] = [
  { group: '待处理', status: 'attention', rows: [{ title: 'Upgrade batond on Windows', unread: true }] },
  { group: '已停止', status: 'stopped', rows: [{ title: 'Run unit tests on Ubuntu' }] },
  {
    group: '运行中',
    status: 'running',
    rows: [
      { title: 'Fix gateway reconnect race', unread: true },
      { title: '整理设备端日志' },
      { title: 'Rebuild web bundle' },
    ],
  },
  { group: '等待设备', status: 'waiting', rows: [{ title: 'Run sleep tests on Windows' }] },
  {
    group: '空闲',
    status: 'idle',
    rows: [
      { title: 'Organize release notes', unread: true },
      { title: 'Write batond README', unread: true },
      { title: '核对中文排版' },
      { title: 'Run compat suite' },
    ],
  },
]

function ThreadStatusList() {
  return (
    <div {...stylex.props(styles.threadList, styles.threadListSample)}>
      {threadSample.map(({ group, status, rows }) => (
        <div key={group} {...stylex.props(styles.threadList)}>
          <div {...stylex.props(text.small, styles.threadGroup)}>
            {group} {rows.length}
          </div>
          {rows.map((row, index) => (
            <div key={row.title} {...stylex.props(text.small, styles.threadRow)}>
              <ThreadStatusIcon status={status} />
              <span {...stylex.props(text.truncate, styles.threadTitle, row.unread && styles.threadUnreadTitle)}>
                {row.title}
              </span>
              <span {...stylex.props(styles.threadUnreadSlot)}>{row.unread && <UnreadDot />}</span>
              <span {...stylex.props(styles.threadTime)}>{index + 2} 分钟</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section {...stylex.props(styles.section)}>
      <h2 {...stylex.props(text.label13Medium, styles.sectionTitle)}>{title}</h2>
      {children}
    </section>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label {...stylex.props(styles.slider)}>
      <span {...stylex.props(styles.sliderHead)}>
        {label}
        <span>{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        {...stylex.props(styles.range)}
      />
    </label>
  )
}

function TuningPanel() {
  const { mode, setMode } = useTheme()
  const [inputs, setInputs] = useState<ThemeInputs>(defaultInputs)
  const [radiusScale, setRadiusScale] = useState<(typeof radiusScales)[number]['value']>('normal')
  const [font, setFont] = useState<(typeof fontChoices)[number]['value']>('geist')

  useEffect(() => {
    applyThemeInputs(inputs)
    return () => applyThemeInputs(null)
  }, [inputs])

  useEffect(() => {
    const root = document.documentElement.style
    const scale = radiusScales.find((choice) => choice.value === radiusScale)?.scale ?? 1
    const base = { inner: 4, sm: 6, md: 8, lg: 12, xl: 16 }
    for (const [name, value] of Object.entries(base)) root.setProperty(`--radius-${name}`, `${value * scale}px`)
    return () => {
      for (const name of Object.keys(base)) root.removeProperty(`--radius-${name}`)
    }
  }, [radiusScale])

  useEffect(() => {
    const root = document.documentElement.style
    const family = fontChoices.find((choice) => choice.value === font)?.family
    if (family) root.setProperty('--font-ui', family)
    else root.removeProperty('--font-ui')
    return () => {
      root.removeProperty('--font-ui')
    }
  }, [font])

  const set = (key: keyof ThemeInputs) => (value: number) => setInputs((current) => ({ ...current, [key]: value }))

  return (
    <aside {...stylex.props(styles.panel)}>
      <h2 {...stylex.props(text.label13Medium)}>调节面板 Tuning</h2>
      <Segmented<ThemeMode>
        label="主题"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'system', label: '系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ]}
      />
      <Slider label="Base hue" value={inputs.baseHue} min={0} max={360} step={1} onChange={set('baseHue')} />
      <Slider
        label="Base chroma"
        value={inputs.baseChroma}
        min={0}
        max={0.03}
        step={0.001}
        onChange={set('baseChroma')}
      />
      <Slider label="Accent hue" value={inputs.accentHue} min={0} max={360} step={1} onChange={set('accentHue')} />
      <Slider
        label="Accent chroma"
        value={inputs.accentChroma}
        min={0}
        max={0.3}
        step={0.01}
        onChange={set('accentChroma')}
      />
      <Slider label="Contrast" value={inputs.contrast} min={0} max={1} step={0.05} onChange={set('contrast')} />
      <Field label="圆角 Radius">
        {(props) => <Select {...props} options={radiusScales} value={radiusScale} onChange={setRadiusScale} />}
      </Field>
      <Field label="界面字体 Font">
        {(props) => <Select {...props} options={fontChoices} value={font} onChange={setFont} />}
      </Field>
      <Button onClick={() => setInputs(defaultInputs)}>恢复默认 Reset</Button>
    </aside>
  )
}

const mentions: ComposerItemValue[] = [
  { id: 'baton', label: 'baton', description: 'Project' },
  { id: 'readme', label: 'README.md', description: '文件 File' },
  { id: 'kaken', label: 'Kaken He', description: '成员 Member' },
]

const commands: ComposerItemValue[] = [
  { id: 'plan', label: 'plan', description: '先出计划', type: 'action' },
  { id: 'review', label: 'review', description: '审查当前改动', type: 'action' },
  { id: 'compact', label: 'compact', description: '压缩上下文', type: 'action' },
]

function SuggestionPopup() {
  return (
    <ComposerPopup>
      <ComposerList>
        {(item: ComposerItemValue) => (
          <ComposerItem key={item.id} value={item}>
            <span>{item.label}</span>
            <span {...stylex.props(styles.faint)}>{item.description}</span>
          </ComposerItem>
        )}
      </ComposerList>
      <ComposerStatus />
    </ComposerPopup>
  )
}

function ComposerGallery() {
  const [plain, setPlain] = useState('')
  return (
    <div {...stylex.props(styles.stack)}>
      <PageComposer
        value={plain}
        onChange={setPlain}
        onSend={() => setPlain('')}
        placeholder="给 Agent 发消息 Message the agent"
        chips={
          <>
            <Chip composer icon="laptop">
              MacBook
            </Chip>
            <Chip composer icon="sparkle">
              gpt-6.1-sol
            </Chip>
          </>
        }
        actions={<IconButton icon="plus" label="添加附件" />}
      />
      <Composer
        triggers={[
          { character: '@', items: mentions },
          { character: '/', items: commands },
        ]}
        onSubmit={() => {}}
      >
        <ComposerInput placeholder="结构化草稿：输入 @ 提及，输入 / 选择命令" />
        <ComposerActions>
          <ComposerActionGroup>
            <Chip composer icon="laptop">
              MacBook
            </Chip>
          </ComposerActionGroup>
          <ComposerActionGroup align="end">
            <ComposerSubmit aria-label="发送">
              <Icon name="arrow-up" size={16} />
            </ComposerSubmit>
          </ComposerActionGroup>
        </ComposerActions>
        <SuggestionPopup />
      </Composer>
    </div>
  )
}

function Overlays() {
  const [dialog, setDialog] = useState(false)
  const [command, setCommand] = useState(false)
  const [selected, setSelected] = useState('all')
  return (
    <div {...stylex.props(styles.row)}>
      <Menu width="wide" trigger={<Button icon="dots">菜单 Menu</Button>}>
        <MenuHeading>Thread</MenuHeading>
        <MenuOption leading={<Icon name="pen" size={15} />} note="R">
          重命名 Rename
        </MenuOption>
        <MenuOption selected={selected === 'all'} onSelect={() => setSelected('all')}>
          全部 All
        </MenuOption>
        <MenuOption selected={selected === 'mine'} onSelect={() => setSelected('mine')} detail="只看我发起的 Thread">
          我的 Mine
        </MenuOption>
        <MenuRule />
        <MenuOption dot="danger">归档 Archive</MenuOption>
      </Menu>
      <Button onClick={() => setDialog(true)}>对话框 Dialog</Button>
      <Button onClick={() => setCommand(true)}>命令面板 Command</Button>
      <Tooltip label="连续悬停时不再等待">
        <Button variant="ghost">提示 Tooltip</Button>
      </Tooltip>
      <Tooltip label="Second tooltip appears instantly">
        <Button variant="ghost">Tooltip 2</Button>
      </Tooltip>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="归档这个 Thread？"
        description="归档后可以在设置里恢复。Archived threads can be restored from settings."
        note="不会停止正在运行的 Turn"
        actions={
          <>
            <Button onClick={() => setDialog(false)}>取消</Button>
            <Button variant="dangerSolid" onClick={() => setDialog(false)}>
              归档
            </Button>
          </>
        }
      />
      <CommandDialog
        open={command}
        onOpenChange={setCommand}
        label="命令面板"
        placeholder="搜索命令 Search commands"
        empty="没有匹配的命令"
        groups={[
          {
            label: 'Thread',
            items: [
              { id: 'new', label: '新建 Thread', shortcut: '⌘N', onSelect: () => {} },
              { id: 'archive', label: 'Archive thread', onSelect: () => {} },
            ],
          },
          {
            label: 'Project',
            items: [
              { id: 'open', label: '打开 Project', leading: <Icon name="projects" size={15} />, onSelect: () => {} },
              { id: 'settings', label: 'Project settings', shortcut: '⌘,', onSelect: () => {} },
            ],
          },
        ]}
      />
    </div>
  )
}

function SettingsScene() {
  const [notify, setNotify] = useState(true)
  const [agent, setAgent] = useState<string | null>('codex')
  return (
    <Frame style={stylex.create({ width: { maxWidth: '640px' } }).width}>
      <FrameHeader>
        <FrameTitle>设备 Device</FrameTitle>
        <FrameDescription>这台设备上可用的 Agent 和通知方式。</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div {...stylex.props(styles.stack)}>
          <Field label="名称 Name" helper="显示在 Thread 的位置选择里。">
            {(props) => <Input {...props} defaultValue="MacBook Pro" />}
          </Field>
          <Field label="默认 Agent">
            {(props) => (
              <Select
                {...props}
                value={agent}
                onChange={setAgent}
                options={[
                  { value: 'codex', label: 'Codex' },
                  { value: 'cursor', label: 'Cursor' },
                  { value: 'pi', label: 'Pi' },
                  { value: 'kiro', label: 'Kiro' },
                ]}
              />
            )}
          </Field>
          <Field label="工作目录" error="目录不存在：/srv/baton">
            {(props) => <Input {...props} defaultValue="/srv/baton" />}
          </Field>
          <Field label="说明 Notes" optional>
            {(props) => <TextArea {...props} placeholder="给同事看的说明" />}
          </Field>
          <div {...stylex.props(styles.settingRow)}>
            <span {...stylex.props(text.small)}>运行结束时通知 Notify when finished</span>
            <Toggle checked={notify} onChange={setNotify} label="运行结束时通知" />
          </div>
        </div>
      </FramePanel>
      <FrameFooter>
        <Button variant="primary">保存 Save</Button>
      </FrameFooter>
    </Frame>
  )
}

function ThreadScene() {
  return (
    <div {...stylex.props(styles.stack)}>
      <h1 {...stylex.props(text.displaySmall)}>Fix websocket reconnect 修复重连</h1>
      <p {...stylex.props(text.copy14, styles.prose)}>
        节点断线后 Worker 会把未确认的命令留在 outbox，重连成功再按序号补发。The worker keeps unacknowledged commands in
        the outbox and replays them in sequence after reconnecting, so a dropped socket never loses a turn.
      </p>
      <div {...stylex.props(branch.title, text.small)}>
        <Icon name="tool" size={14} />
        修改 2 个文件
      </div>
      <div {...stylex.props(branch.line)}>
        <span {...stylex.props(text.mono)}>apps/batond/src/worker/outbox.ts</span>
        <span {...stylex.props(text.mono)}>apps/batond/src/worker/index.ts</span>
      </div>
      <pre {...stylex.props(text.mono, styles.code)}>
        <span {...stylex.props(styles.removed)}>{'- await socket.send(command)\n'}</span>
        <span {...stylex.props(styles.added)}>{'+ await outbox.enqueue(command)\n'}</span>
        <span {...stylex.props(styles.added)}>{'+ await outbox.flush(socket)\n'}</span>
        {'  return receipt'}
      </pre>
      <Banner title="等待设备上线" detail="MacBook Pro 离线，恢复后继续。" />
      <Banner
        attention
        title="需要你决定 Needs your decision"
        detail="Agent 想删除 3 个文件。"
        action={<Button small>查看</Button>}
      />
    </div>
  )
}

function ProjectScene() {
  return (
    <Frame style={stylex.create({ width: { maxWidth: '640px' } }).width}>
      <FramePanel>
        <div {...stylex.props(styles.settingRow)}>
          <div>
            <div {...stylex.props(text.label14Medium)}>Baton</div>
            <div {...stylex.props(text.label13, styles.muted)}>3 个 Thread 运行中 · 12 open items</div>
          </div>
          <AgentMark label="Project Agent" />
        </div>
      </FramePanel>
      <FramePanel>
        <div {...stylex.props(styles.row)}>
          <StatusPill tone="agent">执行中 2</StatusPill>
          <StatusPill tone="attention">等你决定 1</StatusPill>
          <StatusPill tone="success" quiet>
            已完成 28
          </StatusPill>
        </div>
      </FramePanel>
    </Frame>
  )
}

export function Gallery() {
  const [tab, setTab] = useState<'all' | 'open'>('all')
  const [segment, setSegment] = useState<'one' | 'two'>('one')
  const [toggle, setToggle] = useState(false)
  return (
    <div {...stylex.props(styles.page)}>
      <main {...stylex.props(styles.content)}>
        <Section title="颜色 Colors">
          <div {...stylex.props(styles.swatches)}>
            {swatchNames.map((name) => (
              <div key={name} {...stylex.props(styles.swatch)}>
                <span {...stylex.props(styles.chip)} style={{ backgroundColor: semantic[name] }} />
                {name}
              </div>
            ))}
          </div>
        </Section>

        <Section title="文字 Type">
          <div {...stylex.props(text.display)}>Baton 跨设备协同</div>
          <div {...stylex.props(text.displaySmall)}>Thread 与文档大标题 Serif heading</div>
          <div {...stylex.props(text.heading20)}>Heading 20 标题</div>
          <div {...stylex.props(text.heading16)}>Heading 16 标题</div>
          <div {...stylex.props(text.heading14)}>Heading 14 标题</div>
          <div {...stylex.props(text.label14)}>Label 14 界面文字</div>
          <div {...stylex.props(text.label13)}>Label 13 界面文字</div>
          <div {...stylex.props(text.label12)}>Label 12 三级信息</div>
          <p {...stylex.props(text.copy14, styles.prose)}>
            Copy 14 正文。The quick brown fox jumps over the lazy dog，中英文混排时字号和行高保持稳定。
          </p>
          <div {...stylex.props(text.mono)}>const receipt = await outbox.flush(socket) // 0123456789</div>
          <div {...stylex.props(text.pixel)}>BATON 42 RUNNING</div>
        </Section>

        <Section title="按钮 Button">
          <div {...stylex.props(styles.row)}>
            <Button variant="primary">主要 Primary</Button>
            <Button>次要 Secondary</Button>
            <Button variant="ghost">幽灵 Ghost</Button>
            <Button variant="danger">危险 Danger</Button>
            <Button variant="dangerSolid">删除 Delete</Button>
            <Button icon="plus">图标 Icon</Button>
            <Button small>小 Small</Button>
            <Button disabled>禁用 Disabled</Button>
            <IconButton icon="settings" label="设置" />
            <IconButton icon="settings" label="设置（选中）" active />
          </div>
        </Section>

        <Section title="输入区 Composer">
          <ComposerGallery />
        </Section>

        <Section title="浮层 Overlays">
          <Overlays />
        </Section>

        <Section title="导航 Tabs">
          <div {...stylex.props(styles.row)}>
            <Tabs
              label="Thread 筛选"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: '全部 All', count: 24 },
                { value: 'open', label: '进行中 Open', count: 3 },
              ]}
            />
            <Segmented
              label="视图"
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'one', label: '对话' },
                { value: 'two', label: 'Files' },
              ]}
            />
            <Toggle checked={toggle} onChange={setToggle} label="开关" />
          </div>
        </Section>

        <Section title="状态 Status">
          <div {...stylex.props(styles.row)}>
            {tones.map((tone) => (
              <StatusDot key={tone} tone={tone} label={tone} />
            ))}
            {tones.map((tone) => (
              <StatusPill key={tone} tone={tone}>
                {tone}
              </StatusPill>
            ))}
            <StatusChip tone="agent" label="执行中" count={2} />
            <Tag>标签 Tag</Tag>
            <Tag tone="agent">Agent</Tag>
            <Tag tone="attention">注意</Tag>
            <Count value={3} />
            <Count value={12} />
            <UnreadDot />
            <Kbd>⌘K</Kbd>
            <PersonAvatar name="Kaken" />
            <AgentMark />
          </div>
        </Section>

        <Section title="对话状态 Thread status">
          <div {...stylex.props(styles.row)}>
            {threadStatuses.map(({ status, label }) => (
              <span key={status} {...stylex.props(text.small, styles.statusLegend)}>
                <ThreadStatusIcon status={status} label={label} />
                {label}
              </span>
            ))}
          </div>
          <div {...stylex.props(styles.row)}>
            {threadStatuses.map(({ status, label }) => (
              <span key={status} {...stylex.props(text.small, styles.compactStatus)}>
                <StatusDot tone={threadStatusTones[status]} />
                {label}
              </span>
            ))}
          </div>
          <ThreadStatusList />
        </Section>

        <Section title="场景：长 Thread">
          <ThreadScene />
        </Section>
        <Section title="场景：Project 概览">
          <ProjectScene />
        </Section>
        <Section title="场景：设置表单">
          <SettingsScene />
        </Section>
      </main>
      <TuningPanel />
    </div>
  )
}
