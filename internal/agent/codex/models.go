package codex

import (
	"context"
	"errors"

	"baton/internal/agent"
)

// ProbeModels 查询本机 app-server 模型目录，不创建 Thread 或发送输入。
func ProbeModels(ctx context.Context, c agent.Config) (agent.ModelCatalog, error) {
	a := New(c)
	defer a.Close()
	if err := a.connect(ctx); err != nil {
		return agent.ModelCatalog{}, err
	}
	return a.Models(ctx)
}

func (a *Adapter) Models(ctx context.Context) (agent.ModelCatalog, error) {
	a.mu.Lock()
	configuredModel := a.config.Model
	a.mu.Unlock()
	catalog := agent.ModelCatalog{Models: []agent.Model{}, DefaultModel: configuredModel}
	cursor, seen := "", map[string]bool{}
	for {
		var result struct {
			Data []struct {
				ID, Model, DisplayName string
				IsDefault, Hidden      bool
			} `json:"data"`
			NextCursor string `json:"nextCursor"`
		}
		if err := a.call(ctx, "model/list", map[string]any{"cursor": cursorOrNil(cursor), "includeHidden": false}, &result); err != nil {
			return agent.ModelCatalog{}, err
		}
		for _, m := range result.Data {
			if m.Model == "" || m.Hidden {
				continue
			}
			catalog.Models = append(catalog.Models, agent.Model{ID: m.Model, Name: m.DisplayName})
			if m.IsDefault && configuredModel == "" {
				catalog.DefaultModel = m.Model
			}
		}
		if result.NextCursor == "" {
			return catalog, nil
		}
		if seen[result.NextCursor] {
			return agent.ModelCatalog{}, errors.New("Codex model/list cursor repeated")
		}
		seen[result.NextCursor], cursor = true, result.NextCursor
	}
}
