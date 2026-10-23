package protocol

import (
	"strings"
	"testing"
)

func TestProjectRuntimeModelCatalogValidation(t *testing.T) {
	p := &ProjectRuntime{Version: "1", Providers: []RuntimeProvider{{Provider: "real-provider", Status: "available"}}}
	if err := ValidateProjectRuntime(p); err != nil {
		t.Fatal("optional models rejected", err)
	}
	p.Providers[0].Models = []RuntimeModel{{ID: "one", Name: "One"}}
	if err := ValidateProjectRuntime(p); err != nil {
		t.Fatal(err)
	}
	for _, models := range [][]RuntimeModel{
		{{ID: "one", Name: "One"}, {ID: "one", Name: "Duplicate"}},
		{{ID: "bad\n", Name: "Bad"}},
		{{ID: "one", Name: strings.Repeat("x", 513)}},
		make([]RuntimeModel, 65),
	} {
		p.Providers[0].Models = models
		if err := ValidateProjectRuntime(p); err == nil {
			t.Fatalf("invalid catalog accepted: %v", models)
		}
	}
}
