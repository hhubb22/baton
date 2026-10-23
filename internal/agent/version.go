package agent

import (
	"regexp"
	"strconv"
	"strings"
)

var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

// CLIVersionAtLeast 接受达到最低版本的正式版本；构建元数据不参与比较。
func CLIVersionAtLeast(version, minimum string) bool {
	parse := func(value string) ([3]uint64, bool) {
		var parts [3]uint64
		match := releaseVersion.FindStringSubmatch(strings.TrimPrefix(value, "v"))
		if match == nil {
			return parts, false
		}
		for i := range parts {
			n, err := strconv.ParseUint(match[i+1], 10, 64)
			if err != nil {
				return parts, false
			}
			parts[i] = n
		}
		return parts, true
	}
	actual, ok := parse(version)
	if !ok {
		return false
	}
	required, ok := parse(minimum)
	if !ok {
		return false
	}
	for i := range actual {
		if actual[i] != required[i] {
			return actual[i] > required[i]
		}
	}
	return true
}
