import { gunzipSync } from 'node:zlib'
import { Root } from 'protobufjs'

// Fields used by the recorder's OTLP LogsData. Unknown protobuf fields are ignored.
const root = Root.fromJSON({
  nested: {
    LogsData: { fields: { resourceLogs: { rule: 'repeated', type: 'ResourceLogs', id: 1 } } },
    ResourceLogs: {
      fields: { resource: { type: 'Resource', id: 1 }, scopeLogs: { rule: 'repeated', type: 'ScopeLogs', id: 2 } },
    },
    Resource: { fields: { attributes: { rule: 'repeated', type: 'KeyValue', id: 1 } } },
    ScopeLogs: { fields: { logRecords: { rule: 'repeated', type: 'LogRecord', id: 2 } } },
    LogRecord: {
      fields: {
        timeUnixNano: { type: 'fixed64', id: 1 },
        body: { type: 'AnyValue', id: 5 },
        attributes: { rule: 'repeated', type: 'KeyValue', id: 6 },
      },
    },
    KeyValue: { fields: { key: { type: 'string', id: 1 }, value: { type: 'AnyValue', id: 2 } } },
    AnyValue: {
      fields: {
        stringValue: { type: 'string', id: 1 },
        boolValue: { type: 'bool', id: 2 },
        intValue: { type: 'int64', id: 3 },
        doubleValue: { type: 'double', id: 4 },
      },
    },
  },
})
const logsData = root.lookupType('LogsData')
const limit = 1024 * 1024

export function decodeReplayProtobuf(compressed: Uint8Array): unknown {
  if (compressed.byteLength > limit) throw new RangeError('Telemetry request too large')
  const data = gunzipSync(compressed, { maxOutputLength: limit })
  return logsData.toObject(logsData.decode(data), { longs: String })
}
