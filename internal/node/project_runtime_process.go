package node

import (
	"baton/internal/sidecar"
	"os/exec"
)

func startProjectRuntimeProcess(cmd *exec.Cmd) (func(), error) { return sidecar.StartTree(cmd) }
