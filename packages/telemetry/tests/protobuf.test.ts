import { gzipSync } from 'node:zlib'
import { expect, it } from 'vite-plus/test'
import { decodeReplayProtobuf } from '../src/protobuf.ts'

it('限制压缩和解压后的回放请求体大小', () => {
  expect(() => decodeReplayProtobuf(new Uint8Array(1024 * 1024 + 1))).toThrow(RangeError)
  expect(() => decodeReplayProtobuf(gzipSync(Buffer.alloc(1024 * 1024 + 1)))).toThrow()
  expect(() => decodeReplayProtobuf(new Uint8Array([1, 2, 3]))).toThrow()
})
