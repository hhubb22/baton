import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Project } from './sample.ts'

export interface Option {
  key: string
  label: string
  hint?: string
  selected?: boolean
  danger?: boolean
  onPick: () => void
}

export function Select({ label, icon, options, small, mono, align = 'left', up }: {
  label: ReactNode
  icon?: ReactNode
  options: Option[]
  small?: boolean
  mono?: boolean
  align?: 'left' | 'right'
  up?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="select" ref={root}>
      <button type="button" className={`chip${small ? '' : ' chip--lg'}${mono ? ' mono' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon}
        {typeof label === 'string' ? <span className="truncate">{label}</span> : label}
        {typeof label === 'string' ? <Icon name="chevron" /> : null}
      </button>
      {open ? (
        <ul className={`menu menu--${align}${up ? ' menu--up' : ''}`} role="menu">
          {options.map((o) => (
            <li key={o.key}>
              <button type="button" role="menuitem" className={`menu__row${o.danger ? ' menu__row--danger' : ''}`} onClick={() => { o.onPick(); setOpen(false) }}>
                <span className={`truncate${mono ? ' mono' : ''}`}>{o.label}</span>
                {o.hint ? <span className="meta">{o.hint}</span> : null}
                {o.selected ? <Icon name="check" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function Avatar({ project, size = 28 }: { project: Pick<Project, 'title' | 'hue'>; size?: number }) {
  return (
    <span
      className="avatar avatar--project"
      style={{ width: size, height: size, fontSize: size * 0.46, '--hue': project.hue } as CSSProperties}
      aria-hidden="true"
    >
      {project.title.slice(0, 1)}
    </span>
  )
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
      <path d="M7 16.5 16.5 7" stroke="var(--panel)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

const paths = {
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" /></>,
  device: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  pen: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  rail: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  memory: <path d="M6 4h12v16l-6-4-6 4z" />,
  swap: <><path d="M4 8h13l-3-3M20 16H7l3 3" /></>,
}

export type IconName = keyof typeof paths

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
