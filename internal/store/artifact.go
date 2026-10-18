package store

import "baton/internal/task"

func nonNilArtifacts(refs []task.ArtifactRef) []task.ArtifactRef {
	if refs == nil {
		return []task.ArtifactRef{}
	}
	return refs
}
