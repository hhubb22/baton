import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Avatar, Icon, Select } from './controls.tsx'
import { stateLabel } from './labels.ts'
import { devices, type Device, type Entry, type InboxItem, type Project, type Task } from './sample.ts'

export interface Dispatch {
  title: string
  expected: string
  device: Device
  agent: string
  directory: string
}

interface Props {
  project: Project
  entries: Entry[]
  tasks: Task[]
  inbox: InboxItem[]
  answers: Record<string, string>
  thinking: boolean
  overview: boolean
  onToggleOverview: () => void
  onSend: (text: string) => void
  onDispatch: (task: Dispatch) => void
  onAnswer: (itemID: string, answer: string) => void
  onPause: (paused: boolean) => void
  onArchive: () => void
}

export function Conversation(props: Props) {
  const { project, entries, thinking } = props
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [project.id, entries.length, thinking])

  return (
    <section className="conversation" aria-label={project.title}>
      <Header {...props} />
      <div className="transcript" ref={scroller}>
        <div className="transcript__inner">
          {entries.length === 0 ? <Empty project={project} /> : null}
          {entries.map((entry, i) => <EntryView key={i} entry={entry} {...props} />)}
          {thinking ? (
            <div className="msg msg--agent">
              <Avatar project={project} size={24} />
              <div className="msg__body">
                <span className="typing" aria-label="正在处理"><i /><i /><i /></span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="dock">
        {project.status === 'paused' ? (
          <div className="banner">
            <span>已暂停。Project Agent 不会启动，已派出的任务继续执行。</span>
            <button type="button" className="btn" onClick={() => props.onPause(false)}>恢复</button>
          </div>
        ) : null}
        <Composer {...props} />
      </div>
    </section>
  )
}

function Header({ project, inbox, answers, overview, onToggleOverview, onPause, onArchive }: Props) {
  const waiting = inbox.filter((i) => i.projectID === project.id && !answers[i.id]).length
  const sub =
    project.status === 'paused' ? '已暂停'
      : project.status === 'running' && project.runtime ? `在 ${project.runtime}上运行`
        : waiting > 0 ? `${waiting} 件事等你处理`
          : project.status === 'waiting' ? '等待设备上线'
            : '空闲'
  return (
    <header className="conv-head">
      <Avatar project={project} />
      <div className="conv-head__text">
        <h1>{project.title}</h1>
        <span className={`conv-head__sub${project.status === 'running' ? ' is-live' : ''}`}>{sub}</span>
      </div>
      <div className="conv-head__actions">
        <Select
          align="right"
          label={<Icon name="more" />}
          options={[
            { key: 'goal', label: '修改标题和目标', onPick: () => {} },
            project.status === 'paused'
              ? { key: 'resume', label: '恢复', onPick: () => onPause(false) }
              : { key: 'pause', label: '暂停', onPick: () => onPause(true) },
            { key: 'archive', label: '归档', danger: true, onPick: onArchive },
          ]}
        />
        <button type="button" className={`icon-btn${overview ? ' is-on' : ''}`} aria-label="概览" aria-pressed={overview} title="概览" onClick={onToggleOverview}>
          <Icon name="rail" />
          {!overview && waiting > 0 ? <span className="badge-dot" /> : null}
        </button>
      </div>
    </header>
  )
}

function Empty({ project }: { project: Project }) {
  return (
    <div className="empty">
      <Avatar project={project} size={40} />
      <p className="empty__title">{project.title}</p>
      {project.goal ? <p className="empty__goal">{project.goal}</p> : null}
      <p className="empty__hint">这里的对话和记忆会一直保留，换设备运行也接得上。</p>
    </div>
  )
}

function EntryView({ entry, project, tasks, inbox, answers, onAnswer }: Props & { entry: Entry }) {
  switch (entry.kind) {
    case 'day':
      return <div className="day"><span>{entry.label}</span></div>
    case 'note':
      return <p className="note">{entry.text}</p>
    case 'user':
      return (
        <div className="msg msg--user">
          <div className="bubble">{entry.text}</div>
          <span className="meta">{entry.pending ? '等待设备上线' : entry.time}</span>
        </div>
      )
    case 'agent':
      return (
        <div className="msg msg--agent">
          <Avatar project={project} size={24} />
          <div className="msg__body">
            <div className="msg__name">{project.title}<span className="meta">{entry.time}</span></div>
            <p className="prose">{rich(entry.text)}</p>
          </div>
        </div>
      )
    case 'task': {
      const task = tasks.find((t) => t.id === entry.taskID)
      return task ? <TaskCard task={task} /> : null
    }
    case 'inbox': {
      const item = inbox.find((i) => i.id === entry.itemID)
      return item ? <InboxCard item={item} answer={answers[item.id]} onAnswer={onAnswer} /> : null
    }
  }
}

function rich(text: string) {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))
}

function TaskCard({ task }: { task: Task }) {
  return (
    <a className="attach card task-card" href="#">
      <span className={`dot dot--${task.state}`} />
      <span className="task-card__main">
        <span className="task-card__title truncate">{task.title}</span>
        <span className="meta">{task.agent} · {task.device}{task.by === 'user' ? ' · 我派发' : ''}{task.summary ? ` · ${task.summary}` : ''}</span>
      </span>
      <span className={`state state--${task.state}`}>{stateLabel[task.state]}</span>
    </a>
  )
}

export function InboxCard({ item, answer, onAnswer, compact }: { item: InboxItem; answer?: string; onAnswer: (id: string, answer: string) => void; compact?: boolean }) {
  return (
    <div className={`${compact ? '' : 'attach '}card inbox-card${answer ? ' is-done' : ''}`}>
      <div className="inbox-card__head">
        <span className="inbox-card__title">{item.title}</span>
        {item.system ? <span className="meta">由 Baton 创建</span> : null}
      </div>
      <p className="inbox-card__summary">{item.summary}</p>
      {answer ? (
        <p className="inbox-card__answer"><Icon name="check" />{answer}</p>
      ) : (
        <div className="inbox-card__actions">
          {item.options.length > 0
            ? item.options.map((o) => (
                <button key={o.label} type="button" className={`btn${o.suggested ? ' btn--primary' : ''}`} onClick={() => onAnswer(item.id, `已回答：${o.label}`)}>{o.label}</button>
              ))
            : <a className="btn" href="#">查看任务</a>}
          <button type="button" className="btn btn--ghost" onClick={() => onAnswer(item.id, '已关闭')}>关闭</button>
        </div>
      )}
    </div>
  )
}

function Composer({ project, onSend, onDispatch }: Props) {
  const [mode, setMode] = useState<'chat' | 'task'>('chat')
  const [text, setText] = useState('')
  const [expected, setExpected] = useState('')
  const defaultDevice = devices.find((d) => d.online) ?? devices[0]
  const [device, setDevice] = useState<Device>(defaultDevice)
  const [agent, setAgent] = useState(defaultDevice.agents[0])
  const [directory, setDirectory] = useState(defaultDevice.directories[0])
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { input.current?.focus() }, [project.id])

  const anyOnline = devices.some((d) => d.online)
  const canSend = text.trim() !== ''

  function pickDevice(d: Device) {
    setDevice(d)
    setAgent(d.agents[0])
    setDirectory(d.directories[0])
  }

  function send() {
    if (!canSend) return
    if (mode === 'chat') onSend(text.trim())
    else onDispatch({ title: text.trim(), expected, device, agent, directory })
    setText('')
    setExpected('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const note = mode === 'task'
    ? '直接派发，不经过 Project Agent。结果会告诉它，但不会让它开始处理。'
    : project.status === 'paused' ? '消息会保存，恢复后处理'
      : anyOnline ? '' : '所有设备离线，消息会等设备上线后处理'

  return (
    <>
    <div className="composer">
      <textarea
        ref={input}
        className="composer__input"
        rows={1}
        value={text}
        placeholder={mode === 'chat' ? `发消息给 ${project.title}` : '描述任务'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {mode === 'task' ? (
        <input className="composer__expected" value={expected} placeholder="怎样算完成（可选）" onChange={(e) => setExpected(e.target.value)} />
      ) : null}
      <div className="composer__bar">
        <div className="segmented" role="tablist" aria-label="发送方式">
          <button type="button" role="tab" aria-selected={mode === 'chat'} onClick={() => setMode('chat')}>对话</button>
          <button type="button" role="tab" aria-selected={mode === 'task'} onClick={() => setMode('task')}>任务</button>
        </div>
        {mode === 'chat' ? (
          <span className="chip chip--static">{project.model}</span>
        ) : (
          <>
            <Select
              small
              up
              label={device.name}
              icon={<span className={`dot ${device.online ? 'dot--ok' : 'dot--off'}`} />}
              options={devices.map((d) => ({ key: d.id, label: d.name, hint: d.online ? (d.isDefault ? '默认' : '') : '离线', selected: d.id === device.id, onPick: () => pickDevice(d) }))}
            />
            <Select small up label={agent} options={device.agents.map((a) => ({ key: a, label: a, selected: a === agent, onPick: () => setAgent(a) }))} />
            <Select small up mono label={directory} options={device.directories.map((dir) => ({ key: dir, label: dir, selected: dir === directory, onPick: () => setDirectory(dir) }))} />
          </>
        )}
        <button type="button" className="send" aria-label="发送" disabled={!canSend} onClick={send}>
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
    {note ? <p className="composer-note">{note}</p> : null}
    </>
  )
}
