import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { fields, utf8Prefix } from './lexical.ts'

export const projectMemoryDocument = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  itemId: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [r] = yield* sql<{
    revision: number
    title: string
    content: string
    conditions: string
    topic: string
    semantic_key: string
  }>`SELECT r.revision::float8 AS revision,r.title,r.content,r.conditions,r.topic,r.semantic_key FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.id=${itemId}`
  if (!r) return
  const indexed = fields(r.title, r.topic + ' ' + r.semantic_key, r.content + '\n' + r.conditions)
  const tokens = [...new Set(Object.values(indexed).flat())]
  yield* sql`INSERT INTO project_memory_search_documents(employee_id,project_id,document_id,item_id,revision,fields,terms,snippet) VALUES(${employeeId},${projectId},${'item:' + itemId},${itemId},${r.revision},${JSON.stringify(indexed)}::jsonb,array_to_tsvector(${tokens}::text[]),${utf8Prefix(r.content, 2048)}) ON CONFLICT(employee_id,project_id,document_id) DO UPDATE SET revision=excluded.revision,fields=excluded.fields,terms=excluded.terms,snippet=excluded.snippet,created_at=clock_timestamp()`
})

export const projectSourceDocuments = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  sourceId: string,
  text: string,
) {
  const sql = yield* SqlClient.SqlClient
  let offset = 0
  // 分片有确定的 UTF-8 范围；每次检索只读取命中的有限片段。
  while (text.length) {
    let snippet = utf8Prefix(text, 4096)
    const paragraph = snippet.lastIndexOf('\n\n')
    if (paragraph > snippet.length / 2) snippet = snippet.slice(0, paragraph + 2)
    const end = offset + Buffer.byteLength(snippet)
    const indexed = fields('', '', snippet)
    const tokens = [...new Set(indexed.content)]
    yield* sql`INSERT INTO project_memory_search_documents(employee_id,project_id,document_id,source_id,start_byte,end_byte,fields,terms,snippet) VALUES(${employeeId},${projectId},${`source:${sourceId}:${offset}`},${sourceId},${offset},${end},${JSON.stringify(indexed)}::jsonb,array_to_tsvector(${tokens}::text[]),${snippet}) ON CONFLICT DO NOTHING`
    offset = end
    text = text.slice(snippet.length)
  }
})
