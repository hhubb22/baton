import { useState, type FormEvent } from 'react'
import { currentDefaultText, eligibleDefaultNodes, savedDefaultSummary } from '../model.ts'
import type { NodeList, SavedDefault } from '../types.ts'

type Props = {
  list: NodeList
  saved: SavedDefault | null
  canWrite: boolean
  busy: boolean
  onSave: (nodeId: string) => void
}

export function DefaultPCForm({ list, saved, canWrite, busy, onSave }: Props) {
  const [choice, setChoice] = useState('')
  const options = eligibleDefaultNodes(list.nodes)
  const selected = options.some((node) => node.id === choice) ? choice : ''
  const chosen = options.find((node) => node.id === selected)
  const invalid = list.default_pc.invalid || list.default_pc.needs_reselection

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canWrite || busy || selected === '') return
    onSave(selected)
  }

  return (
    <section className="card">
      <h2>默认 PC</h2>
      <p data-testid="default-pc-current">当前默认 PC：{currentDefaultText(list)}</p>
      {invalid ? (
        <p className="error" role="alert" data-testid="default-pc-invalid">{list.default_pc.message}</p>
      ) : null}
      {saved ? <p data-testid="default-pc-saved">这次保存的结果：{savedDefaultSummary(saved)}</p> : null}
      <form onSubmit={submit}>
        <label>
          改成其他 PC
          <select
            data-testid="default-pc-select"
            value={selected}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">请选择</option>
            {options.map((node) => (
              <option key={node.id} value={node.id}>
                {node.display_name}（{node.online ? '在线' : '离线'}）
              </option>
            ))}
          </select>
        </label>
        {chosen && !chosen.online ? (
          <p data-testid="default-pc-offline">该节点当前离线，仍可以保存为默认 PC。</p>
        ) : null}
        <button data-testid="default-pc-save" type="submit" disabled={!canWrite || busy || selected === ''}>
          {busy ? '正在保存' : '保存默认 PC'}
        </button>
      </form>
    </section>
  )
}
