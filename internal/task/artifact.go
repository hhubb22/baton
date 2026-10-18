package task

import (
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
)

const CodeArtifactUnavailable = "artifact_unavailable"

// ArtifactRef 指向目标节点已登记目录中的文件，不表示文件已经交付。
type ArtifactRef struct {
	NodeID string `json:"node_id"`
	RootID string `json:"root_id"`
	Path   string `json:"path"`
}

func validateRequiredArtifacts(refs []ArtifactRef) error {
	if len(refs) > maxResultRefs {
		return reject(CodeInvalidRequest, "所需产物引用过多", "required_artifacts")
	}
	for _, ref := range refs {
		if _, err := identity.ParseUUID(ref.NodeID); err != nil {
			return reject(CodeInvalidRequest, "产物引用缺少有效节点", "required_artifacts")
		}
		if !agentTypePattern.MatchString(ref.RootID) || strings.TrimSpace(ref.Path) == "" || utf8.RuneCountInString(ref.Path) > maxRefRunes || hasControl(ref.Path) {
			return reject(CodeInvalidRequest, "产物引用需要授权目录和受限资源路径", "required_artifacts")
		}
	}
	return nil
}

func copyArtifacts(refs []ArtifactRef) []ArtifactRef {
	out := append([]ArtifactRef(nil), refs...)
	for i := range out {
		out[i].NodeID = strings.ToLower(out[i].NodeID)
	}
	return out
}
