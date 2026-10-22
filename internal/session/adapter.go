package session

import (
	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
	"baton/internal/agent/shell"
)

type adapterRegistration struct {
	new                          func(agent.Config) agent.Adapter
	modelEnv, binaryEnv, homeEnv string
}

var registeredAdapters = map[string]adapterRegistration{
	"shell": {func(c agent.Config) agent.Adapter { return shell.New(c) }, "", "", ""},
	"kiro":  {func(c agent.Config) agent.Adapter { return kiro.New(c) }, "BATON_KIRO_MODEL", "BATON_KIRO_BINARY", "BATON_KIRO_HOME"},
	"pi":    {func(c agent.Config) agent.Adapter { return pi.New(c) }, "BATON_PI_MODEL", "BATON_PI_BIN", "BATON_PI_HOME"},
	"codex": {func(c agent.Config) agent.Adapter { return codex.New(c) }, "BATON_CODEX_MODEL", "BATON_CODEX_BINARY", "BATON_CODEX_HOME"},
}
