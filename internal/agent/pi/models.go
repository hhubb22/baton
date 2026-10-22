package pi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"baton/internal/agent"
	"github.com/google/uuid"
)

// ProbeModels 查询本机 Pi 模型目录，不发送 prompt。
func ProbeModels(ctx context.Context, c agent.Config) (agent.ModelCatalog, error) {
	dir, err := os.MkdirTemp("", "baton-pi-models-")
	if err != nil {
		return agent.ModelCatalog{}, err
	}
	defer os.RemoveAll(dir)
	c.SessionDir, c.StatePath, c.SessionID = filepath.Join(dir, "session"), filepath.Join(dir, "state.json"), uuid.NewString()
	c.Restore, c.ExecutionID = false, ""
	a := New(c)
	defer a.Close()
	if err := a.Start(ctx); err != nil {
		return agent.ModelCatalog{}, err
	}
	return a.Models(ctx)
}

func (a *Adapter) Models(ctx context.Context) (agent.ModelCatalog, error) {
	r, err := a.call(ctx, "get_available_models", nil)
	if err != nil {
		return agent.ModelCatalog{}, err
	}
	var data struct {
		Models []struct{ Provider, ID, Name string } `json:"models"`
	}
	if err := json.Unmarshal(r.Data, &data); err != nil {
		return agent.ModelCatalog{}, err
	}
	catalog := agent.ModelCatalog{Models: []agent.Model{}, DefaultModel: a.Model()}
	for _, m := range data.Models {
		if m.Provider != "" && m.ID != "" {
			catalog.Models = append(catalog.Models, agent.Model{ID: m.Provider + "/" + m.ID, Name: m.Name})
		}
	}
	return catalog, nil
}
