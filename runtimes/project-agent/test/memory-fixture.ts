// 本地模型替身从实际输入和来源读取回执构造证据，遵循生产工具契约。
export function memoryFixture() {
  let input: { source_seq: number; input_id?: number } | undefined
  let evidence: { source_id: string; source_hash: string; start_byte: number; end_byte: number }[] | undefined
  return {
    get input() {
      return input
    },
    get evidence() {
      return evidence
    },
    observe(request: { operation: string; tool_name?: string }, result: any) {
      const data = result.data
      if (request.operation === 'claim_inputs' && data?.event && !input) {
        const event = data.event
        const content = event.payload.message.content
        const text =
          typeof content === 'string'
            ? content
            : content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
        const inputs = JSON.parse(text)
        const user = inputs.find((entry: any) => entry.source_type === 'user_message')
        if (user) input = { source_seq: event.seq, input_id: Number(user.id) }
      }
      if (
        request.operation === 'call_tool' &&
        request.tool_name === 'memory.read' &&
        data?.payload?.message &&
        !data.payload.message.isError
      ) {
        const source = JSON.parse(data.payload.message.content[0].text)
        if (source.id && source.source_hash)
          evidence = [
            {
              source_id: source.id,
              source_hash: source.source_hash,
              start_byte: source.offset,
              end_byte: source.next_offset,
            },
          ]
      }
    },
  }
}
