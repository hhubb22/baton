package kiro

import (
	"context"

	"baton/internal/agent"
)

type newSessionResult struct {
	SessionID string `json:"sessionId"`
	Models    struct {
		CurrentModelID  string                           `json:"currentModelId"`
		AvailableModels []struct{ ModelID, Name string } `json:"availableModels"`
	} `json:"models"`
	ConfigOptions []struct {
		ID, Category, CurrentValue string
		Options                    []struct{ Value, Name string }
	} `json:"configOptions"`
}

func (r newSessionResult) catalog() agent.ModelCatalog {
	c := agent.ModelCatalog{Models: []agent.Model{}, DefaultModel: r.Models.CurrentModelID}
	for _, m := range r.Models.AvailableModels {
		if m.ModelID != "" {
			c.Models = append(c.Models, agent.Model{ID: m.ModelID, Name: m.Name})
		}
	}
	if len(c.Models) != 0 {
		return c
	}
	for _, option := range r.ConfigOptions {
		if option.ID != "model" && option.Category != "model" {
			continue
		}
		c.DefaultModel = option.CurrentValue
		for _, m := range option.Options {
			if m.Value != "" {
				c.Models = append(c.Models, agent.Model{ID: m.Value, Name: m.Name})
			}
		}
		break
	}
	return c
}

func (a *Adapter) newSession(ctx context.Context) (newSessionResult, error) {
	p := map[string]any{"cwd": a.config.Directory, "mcpServers": []any{}}
	if a.config.Model != "" {
		p["_meta"] = map[string]any{"kiro": map[string]string{"modelId": a.config.Model}}
	}
	var result newSessionResult
	err := a.call(ctx, "session/new", p, &result)
	return result, err
}

// ProbeModels 从 session/new 的模型信息读取目录，不发送 prompt。
func ProbeModels(ctx context.Context, c agent.Config) (agent.ModelCatalog, error) {
	a := New(c)
	defer a.Close()
	if err := a.connect(ctx); err != nil {
		return agent.ModelCatalog{}, err
	}
	r, err := a.newSession(ctx)
	if err != nil {
		return agent.ModelCatalog{}, err
	}
	return r.catalog(), nil
}
