package agent

// Model 使用原生接口接受的模型标识。
type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ModelCatalog struct {
	Models       []Model `json:"models"`
	DefaultModel string  `json:"default_model"`
}
