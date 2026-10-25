import { expect, it } from 'vite-plus/test'
import { TraceOutput } from './trace-output.ts'

it.each(['HEAD' + '中🙂\n'.repeat(50000) + 'TAIL', 'HEAD' + '\u0000'.repeat(250000) + 'TAIL'])(
  'counts original JSON bytes with bounded output',
  (text) => {
    const bytes = Buffer.from(text)
    const output = new TraceOutput()
    for (let i = 0; i < bytes.length; i += 17) output.write(bytes.subarray(i, i + 17))
    const result = output.result(0)
    const original = result.encoding === 'base64' ? bytes.toString('base64') : text
    expect(result.original_output_json_bytes).toBe(Buffer.byteLength(JSON.stringify(original)))
    expect(result.total_bytes).toBe(bytes.length)
    expect(Buffer.from(result.output, result.encoding ?? 'utf8').length).toBeLessThanOrEqual(192 * 1024)
    expect(result.truncated).toBe(true)
  },
)
