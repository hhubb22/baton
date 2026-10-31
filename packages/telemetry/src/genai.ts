const jsonAttributes = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
])
const contentAttributes = new Set([...jsonAttributes, 'gen_ai.system_instructions'])

const utf8Prefix = (value: string, maxBytes: number) => {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

const pruneJson = (value: unknown, excessBytes: number, preserveEnd: boolean): unknown => {
  if (typeof value === 'string') return utf8Prefix(value, Math.max(0, Buffer.byteLength(value) - excessBytes))
  if (Array.isArray(value)) {
    if (!value.length) return value
    const result = value.slice()
    const index = preserveEnd ? 0 : result.length - 1
    const pruned = pruneJson(result[index], excessBytes, preserveEnd)
    if (JSON.stringify(pruned) === JSON.stringify(result[index])) result.splice(index, 1)
    else result[index] = pruned
    return result
  }
  if (value !== null && typeof value === 'object') {
    const result = { ...(value as Record<string, unknown>) }
    const keys = Object.keys(result)
    const last = keys.at(-1)
    if (last === undefined) return result
    const pruned = pruneJson(result[last], excessBytes, preserveEnd)
    if (JSON.stringify(pruned) === JSON.stringify(result[last])) delete result[last]
    else result[last] = pruned
    return result
  }
  return value
}

const boundJson = (value: string, maxBytes: number, preserveEnd: boolean) => {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return '[]'
  }
  let encoded = value
  while (Buffer.byteLength(encoded) > maxBytes) {
    decoded = pruneJson(decoded, Buffer.byteLength(encoded) - maxBytes, preserveEnd)
    encoded = JSON.stringify(decoded)
  }
  return encoded
}

export const boundAttributeString = (key: string, value: string) => {
  if (!contentAttributes.has(key)) return utf8Prefix(value, 256)
  const maxBytes = key === 'gen_ai.output.messages' ? 1024 * 1024 : 128 * 1024
  if (Buffer.byteLength(value) <= maxBytes) return value
  return jsonAttributes.has(key)
    ? boundJson(value, maxBytes, key === 'gen_ai.output.messages')
    : utf8Prefix(value, maxBytes)
}
