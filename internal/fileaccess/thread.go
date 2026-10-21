package fileaccess

import (
	"context"
	"path/filepath"
	"regexp"
	"strings"
)

// ThreadAttachment 是回复中的本地文件或 Git commit 引用。
type ThreadAttachment struct {
	Kind         string `json:"kind"`
	NodeID       string `json:"node_id,omitempty"`
	RootID       string `json:"root_id,omitempty"`
	Path         string `json:"path,omitempty"`
	AccessStatus string `json:"access_status,omitempty"`
	Repo         string `json:"repo,omitempty"`
	SHA          string `json:"sha,omitempty"`
}

var threadCommitPattern = regexp.MustCompile(`\bcommit[ \t]+([0-9a-fA-F]{7,40})\b`)
var threadPathPattern = regexp.MustCompile("`([^`\\r\\n]+)`|\"([^\"\\r\\n]+)\"|[^\\s<>\\[\\](){}\"`]+")

// ParseThreadAttachments 只登记能在授权根内打开的普通文件；正文由调用方保留。
func ParseThreadAttachments(dataDir, nodeID, workingDir, content string) ([]ThreadAttachment, error) {
	roots, err := ListBrowseRoots(dataDir)
	if err != nil {
		return nil, err
	}
	result := []ThreadAttachment{}
	seen := map[string]bool{}
	for _, match := range threadPathPattern.FindAllStringSubmatch(content, -1) {
		candidate := match[0]
		if match[1] != "" {
			candidate = match[1]
		} else if match[2] != "" {
			candidate = match[2]
		} else {
			candidate = strings.TrimRight(candidate, ",;:.，。；：")
		}
		if candidate == "" || strings.Contains(candidate, "://") {
			continue
		}
		absolute := candidate
		if !filepath.IsAbs(absolute) {
			absolute = filepath.Join(workingDir, absolute)
		}
		if !filepath.IsAbs(absolute) || nodeID == "" {
			continue
		}
		for _, root := range roots {
			rel, err := filepath.Rel(root.Path, absolute)
			if err != nil || !filepath.IsLocal(rel) {
				continue
			}
			rel = filepath.ToSlash(rel)
			f, err := openAuthorized(roots, root.ID, rel)
			if err != nil {
				continue
			}
			info, err := f.Stat()
			_ = f.Close()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			key := root.ID + ":" + rel
			if !seen[key] {
				seen[key] = true
				result = append(result, ThreadAttachment{Kind: "file", NodeID: nodeID, RootID: root.ID, Path: rel, AccessStatus: "available"})
			}
			break
		}
	}
	commits := threadCommitPattern.FindAllStringSubmatch(content, -1)
	if len(commits) > 0 {
		repo := threadWorkingOrigin(roots, workingDir)
		if repo != "" {
			for _, match := range commits {
				sha := strings.ToLower(match[1])
				key := "commit:" + sha
				if !seen[key] {
					seen[key] = true
					result = append(result, ThreadAttachment{Kind: "commit", Repo: repo, SHA: sha})
				}
			}
		}
	}
	return result, nil
}

func threadWorkingOrigin(roots []BrowseRoot, workingDir string) string {
	for _, entry := range roots {
		rel, err := filepath.Rel(entry.Path, workingDir)
		if err != nil || !filepath.IsLocal(rel) {
			continue
		}
		root, err := openConfiguredRoot(entry.Path)
		if err != nil {
			continue
		}
		origin := func() string {
			defer root.Close()
			for {
				gitPath := filepath.Join(rel, ".git")
				if info, err := root.Lstat(gitPath); err == nil {
					// 首个仓库边界没有 origin 时，不继承外层仓库的 origin。
					if !info.IsDir() && !info.Mode().IsRegular() {
						return ""
					}
					origin, _ := runtimeOrigin(context.Background(), root, entry.Path, gitPath, info.IsDir())
					return origin
				}
				if rel == "." {
					return ""
				}
				rel = filepath.Dir(rel)
			}
		}()
		if origin != "" {
			return origin
		}
	}
	return ""
}
