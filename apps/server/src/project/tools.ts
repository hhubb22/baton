import { AppError } from '../errors.ts'

export function resultBytes(value: unknown, callId = 'x'.repeat(128)) {
  return Buffer.byteLength(
    JSON.stringify({
      format: 'pi-ai/1',
      message: {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'x'.repeat(128),
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
        timestamp: 9999999999999,
      },
    }),
  )
}
export function projectToolJSONPage(
  value: unknown,
  options: { offset?: number; max_bytes?: number } = {},
  pagination: { page_cursor?: string } = {},
) {
  const raw = Buffer.from(JSON.stringify(value))
  const offset = options.offset ?? 0
  if (offset > raw.length || (offset < raw.length && (raw[offset]! & 0xc0) === 0x80))
    throw new AppError(422, 'invalid_offset')
  let end = Math.min(raw.length, offset + (options.max_bytes || 16384))
  const make = () => {
    while (end > offset && end < raw.length && (raw[end]! & 0xc0) === 0x80) end--
    return {
      ...pagination,
      encoding: 'json',
      text: raw.subarray(offset, end).toString(),
      offset,
      total_bytes: raw.length,
      truncated: end < raw.length,
      ...(end < raw.length ? { next_offset: end } : {}),
    }
  }
  let out = make()
  while (resultBytes(out) > 30000 && end > offset) {
    end = offset + Math.floor((end - offset) * 0.75)
    out = make()
  }
  if (resultBytes(out) > 30000 || (end === offset && offset < raw.length))
    throw new AppError(422, 'max_bytes_too_small')
  return out
}
export function boundedBase64(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, 'base64')
  const half = Math.floor((Math.floor(maxBytes / 4) * 3) / 2)
  return bytes.length <= half * 2
    ? text
    : Buffer.concat([bytes.subarray(0, half), bytes.subarray(bytes.length - half)]).toString('base64')
}
