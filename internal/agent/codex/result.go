package codex

import "encoding/json"

const Instructions = `You are executing the currently bound Baton task. Treat authorization_scope as a limit, never expand it. Return the requested JSON result; do not invent evidence. Finish only after all child tasks are handled. Free text and process exit are not task success.`

func ResultSchema() json.RawMessage {
	return json.RawMessage(`{
  "type":"object", "additionalProperties":false,
  "required":["status","summary","evidence","artifacts","evidence_empty_reason","artifacts_empty_reason","error"],
  "properties":{
    "status":{"type":"string","enum":["completed","failed","needs_verification"]},
    "summary":{"type":"string"},
    "evidence":{"type":"array","items":{"$ref":"#/$defs/ref"}},
    "artifacts":{"type":"array","items":{"$ref":"#/$defs/ref"}},
    "evidence_empty_reason":{"type":"string"},
    "artifacts_empty_reason":{"type":"string"},
    "error":{"anyOf":[{"type":"null"},{
      "type":"object","additionalProperties":false,"required":["code","message"],
      "properties":{"code":{"type":"string","enum":["execution_failed","result_format"]},"message":{"type":"string"}}
    }]}
  },
  "$defs":{"ref":{
    "type":"object","additionalProperties":false,"required":["storage_ref","resource_id","access_status","note"],
    "properties":{
      "storage_ref":{"type":"string"},"resource_id":{"type":"string"},
      "access_status":{"type":"string","enum":["available","unavailable","unknown"]},"note":{"type":"string"}
    }
  }}
}`)
}
