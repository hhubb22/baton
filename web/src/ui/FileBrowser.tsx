import { useState } from 'react'
import { ApiError, messageOf } from '../api.ts'
import type { FileQuery, FileView } from '../types.ts'

type Props = {
  nodeId: string
  online: boolean
  revoked: boolean
  load: (nodeId: string, query: FileQuery) => Promise<FileView>
}

export function FileBrowser({ nodeId, online, revoked, load }: Props) {
  const [open, setOpen] = useState(false)
  const [rootId, setRootId] = useState('')
  const [directory, setDirectory] = useState('')
  const [view, setView] = useState<FileView | null>(null)
  const [preview, setPreview] = useState<FileView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const blocked = !online || revoked

  async function run(query: FileQuery, parentDirectory: string) {
    setLoading(true)
    setError('')
    setPreview(null)
    try {
      const result = await load(nodeId, query)
      if (result.kind === 'file') {
        setRootId(query.root_id ?? '')
        setDirectory(parentDirectory)
        setPreview(result)
        return
      }
      setPreview(null)
      setView(result)
      if (result.kind === 'directory') {
        setRootId(query.root_id ?? '')
        setDirectory(query.path ?? '')
        return
      }
      setRootId('')
      setDirectory('')
    } catch (err) {
      setError(messageOf(err))
      if (err instanceof ApiError && (err.code === 'path_escaped' || err.code === 'root_forbidden' || err.code === 'not_text')) {
        setPreview(null)
      }
    } finally {
      setLoading(false)
    }
  }

  function openBrowser() {
    setOpen(true)
    setView(null)
    setPreview(null)
    setRootId('')
    setDirectory('')
    void run({}, '')
  }

  const roots = view?.kind === 'roots' ? view.roots ?? [] : []
  const entries = view?.kind === 'directory' ? view.entries ?? [] : []

  return (
    <section className="browse" data-testid="file-browser">
      <button
        data-testid="browse-open"
        type="button"
        className="secondary"
        disabled={blocked || loading}
        onClick={openBrowser}
      >
        浏览文件
      </button>
      {!online ? <p data-testid="browse-offline">节点离线，不能浏览文件。</p> : null}
      {revoked ? <p data-testid="browse-revoked">该节点已吊销，不能浏览文件。</p> : null}
      {open && !blocked ? (
        <div>
          {error ? <p className="error" role="alert" data-testid="browse-error">{error}</p> : null}
          {loading ? <p>正在读取。</p> : null}
          {view?.kind === 'roots' ? (
            <div data-testid="browse-roots">
              {roots.length === 0 ? <p>这个节点还没有授权目录。请在节点上用 batond files add 登记。</p> : null}
              <div className="actions">
                {roots.map((root) => (
                  <button
                    key={root.id}
                    type="button"
                    className="secondary"
                    data-testid={`browse-root-${root.id}`}
                    disabled={loading}
                    onClick={() => void run({ root_id: root.id }, '')}
                  >
                    {root.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {rootId ? (
            <div>
              <p data-testid="browse-path">{rootId}{directory ? ` / ${directory}` : ''}</p>
              <div className="actions">
                <button type="button" className="secondary" disabled={loading} onClick={() => void run({}, '')}>
                  授权目录
                </button>
                {directory ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={loading}
                    onClick={() => {
                      const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : ''
                      void run({ root_id: rootId, path: parent || undefined }, parent)
                    }}
                  >
                    上一级
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {view?.kind === 'directory' ? (
            <div data-testid="browse-entries">
              {entries.length === 0 ? <p>这个目录是空的。</p> : null}
              <div className="actions">
                {entries.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    className="secondary"
                    data-testid={`browse-entry-${entry.name}`}
                    disabled={loading}
                    onClick={() => {
                      const next = directory ? `${directory}/${entry.name}` : entry.name
                      void run({ root_id: rootId, path: next }, entry.kind === 'directory' ? next : directory)
                    }}
                  >
                    {entry.kind === 'directory' ? `${entry.name}/` : entry.name}
                  </button>
                ))}
              </div>
              {view.next_cursor ? (
                <button
                  type="button"
                  className="secondary"
                  data-testid="browse-more"
                  disabled={loading}
                  onClick={() => void run({ root_id: rootId, path: directory || undefined, cursor: view.next_cursor }, directory)}
                >
                  更多条目
                </button>
              ) : null}
              {view.truncated ? <p data-testid="browse-list-truncated">这次没有列完该目录。</p> : null}
            </div>
          ) : null}
          {preview?.kind === 'file' ? (
            <div>
              <pre data-testid="browse-preview">{preview.content ?? ''}</pre>
              {preview.truncated ? (
                <p data-testid="browse-truncated">预览已截断。剩余内容仍在节点本地，浏览接口不会继续传输。</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
