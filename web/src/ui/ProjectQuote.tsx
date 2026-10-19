import { useRef, type ReactNode } from 'react'
import type { AskProject } from '../inbox.ts'
import { projectQuote, selectedQuote, type QuoteSource } from '../project-quote.ts'

export function ProjectQuote({ projectID, source, askProject, children }: { projectID?: string; source: QuoteSource; askProject?: AskProject; children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null)
  return <div className="project-quote"><div ref={target}>{children}</div>
    {projectID && askProject && <button className="secondary" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => {
      const selection = target.current ? selectedQuote(target.current) : { text: '', startLine: 1, endLine: 1 }
      askProject(projectID, projectQuote(selection.text, { ...source, ...(source.path && selection.text ? { startLine: selection.startLine, endLine: selection.endLine } : {}) }))
    }}>问 Project Agent</button>}
  </div>
}
