package protocol

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"baton/internal/identity"
)

func TestPrepareNodeEnvelopeStampsSourceAndKeepsUnknownFields(t *testing.T) {
	messageID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"version":1,"message_id":"` + messageID + `","route":{"to":"control"},"priority":"control","body":{"type":"node.sync"},"trace":"keep"}`)
	out, err := PrepareNodeEnvelope(raw, Source{NodeID: "n", EmployeeID: "e", CredentialID: "c", ConnID: "k"})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(out, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["trace"] != "keep" {
		t.Fatalf("未知字段被丢弃: %#v", fields)
	}
	source, _ := fields["source"].(map[string]any)
	if source["kind"] != SourceNode || source["node_id"] != "n" || source["conn_id"] != "k" {
		t.Fatalf("来源没有按认证结果附加: %#v", source)
	}
	route, _ := fields["route"].(map[string]any)
	if route["to"] != ToControl {
		t.Fatalf("目标被改成 %v", route["to"])
	}
}

func TestPrepareNodeEnvelopeRejectsForgedSourceAndForeignRoute(t *testing.T) {
	messageID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	other, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	forged := []byte(`{"version":1,"message_id":"` + messageID + `","route":{"to":"control"},"source":{"kind":"node"}}`)
	if _, err := PrepareNodeEnvelope(forged, Source{}); !errors.Is(err, ErrForgedSource) {
		t.Fatalf("伪造来源得到 %v", err)
	}
	routed := []byte(`{"version":1,"message_id":"` + messageID + `","route":{"to":"` + other + `"}}`)
	if _, err := PrepareNodeEnvelope(routed, Source{}); !errors.Is(err, ErrRouteForbidden) {
		t.Fatalf("节点直投得到 %v", err)
	}
	if CodeOf(ErrForgedSource) != CodeForgedSource || CodeOf(ErrRouteForbidden) != CodeRouteForbidden {
		t.Fatal("错误码映射不正确")
	}
}

func TestPrepareControlEnvelopeSelectsNodeAndDropsCallerSource(t *testing.T) {
	messageID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"version":1,"message_id":"` + messageID + `","route":{"to":"` + nodeID + `"},"source":{"kind":"node","node_id":"forged"},"body":{"type":"ping"}}`)
	gotID, out, err := PrepareControlEnvelope(raw)
	if err != nil {
		t.Fatal(err)
	}
	if gotID != nodeID {
		t.Fatalf("目标节点是 %s", gotID)
	}
	if strings.Contains(string(out), "forged") {
		t.Fatal("控制连接保留了调用方来源")
	}
	var env Envelope
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatal(err)
	}
	if env.Source == nil || env.Source.Kind != SourceControl || env.Route.To != nodeID {
		t.Fatalf("控制来源不正确: %#v", env.Source)
	}
	if _, _, err := PrepareControlEnvelope([]byte(`{"version":1,"message_id":"` + messageID + `","route":{"to":"control"}}`)); !errors.Is(err, ErrRouteForbidden) {
		t.Fatal("控制连接被允许使用非节点目标")
	}
}
