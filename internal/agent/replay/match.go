package replay

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

var capturePattern = regexp.MustCompile(`<\$[a-zA-Z_][a-zA-Z0-9_]*>`)
var tokenPattern = regexp.MustCompile(`<\$?[a-zA-Z_][a-zA-Z0-9_]*>`)

func wholeCapture(s string) bool { return capturePattern.FindString(s) == s && s != "" }

// Match 在 JSON 解码后比较；只有整帧匹配成功才提交新捕获。
func Match(expected, actual json.RawMessage, bindings map[string]string, captures map[string]any) error {
	e, err := decode(expected)
	if err != nil {
		return err
	}
	a, err := decode(actual)
	if err != nil {
		return err
	}
	state := make(map[string]any, len(captures))
	for k, v := range captures {
		state[k] = v
	}
	if err := compare(e, a, bindings, state, "$"); err != nil {
		return err
	}
	for k, v := range state {
		captures[k] = v
	}
	return nil
}

func compare(e, a any, bindings map[string]string, captures map[string]any, path string) error {
	bad := func() error { return fmt.Errorf("%s: 期望 %v，实际 %v", path, e, a) }
	switch v := e.(type) {
	case string:
		if v == "<any>" {
			return nil
		}
		if wholeCapture(v) {
			if old, ok := captures[v]; ok {
				if !reflect.DeepEqual(old, a) {
					return bad()
				}
			} else {
				captures[v] = a
			}
			return nil
		}
		actual, ok := a.(string)
		if !ok {
			return bad()
		}
		// 交付信封作为 JSON 字符串发送，内部按同一结构规则比较。
		if tokenPattern.MatchString(v) {
			expectedJSON, eerr := decode([]byte(v))
			actualJSON, aerr := decode([]byte(actual))
			if eerr == nil && aerr == nil {
				switch expectedJSON.(type) {
				case map[string]any, []any:
					return compare(expectedJSON, actualJSON, bindings, captures, path+"(JSON)")
				}
			}
		}
		return matchString(v, actual, bindings, captures, path)
	case map[string]any:
		actual, ok := a.(map[string]any)
		if !ok || len(v) != len(actual) {
			return bad()
		}
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			av, ok := actual[k]
			if !ok {
				return bad()
			}
			if err := compare(v[k], av, bindings, captures, path+"."+k); err != nil {
				return err
			}
		}
	case []any:
		actual, ok := a.([]any)
		if !ok || len(v) != len(actual) {
			return bad()
		}
		for i := range v {
			if err := compare(v[i], actual[i], bindings, captures, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	default:
		if !reflect.DeepEqual(e, a) {
			return bad()
		}
	}
	return nil
}

func textValue(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	switch v.(type) {
	case json.Number, bool, nil:
		raw, err := json.Marshal(v)
		return string(raw), err
	default:
		return "", fmt.Errorf("嵌入字符串的捕获值必须是标量")
	}
}

func matchString(pattern, actual string, bindings map[string]string, captures map[string]any, path string) error {
	// 录制中的绝对路径由绑定开头；后续分隔符随回放系统转换，普通文本仍逐字比较。
	if filepath.IsAbs(actual) {
		for token, value := range bindings {
			if filepath.IsAbs(value) && strings.HasPrefix(pattern, token+"/") {
				pattern = filepath.FromSlash(pattern)
				actual = filepath.FromSlash(actual)
				break
			}
		}
	}
	var expression strings.Builder
	// 固定片段先转义，绑定内容不会被当成新的占位符或正则表达式。
	expression.WriteString("(?s)^")
	var names []string
	last := 0
	for _, loc := range tokenPattern.FindAllStringIndex(pattern, -1) {
		expression.WriteString(regexp.QuoteMeta(pattern[last:loc[0]]))
		token := pattern[loc[0]:loc[1]]
		if wholeCapture(token) {
			if v, ok := captures[token]; ok {
				s, err := textValue(v)
				if err != nil {
					return err
				}
				expression.WriteString(regexp.QuoteMeta(s))
			} else {
				expression.WriteString("(.*?)")
				names = append(names, token)
			}
		} else if token == "<any>" {
			expression.WriteString(regexp.QuoteMeta(token))
		} else {
			// 未声明的 <name> 是录制内容本身，例如 Pi 系统提示里的 <tools>。
			v, ok := bindings[token]
			if !ok {
				v = token
			}
			expression.WriteString(regexp.QuoteMeta(v))
		}
		last = loc[1]
	}
	expression.WriteString(regexp.QuoteMeta(pattern[last:]))
	expression.WriteString("$")
	matches := regexp.MustCompile(expression.String()).FindStringSubmatch(actual)
	if matches == nil {
		return fmt.Errorf("%s: 字符串不匹配", path)
	}
	for i, name := range names {
		if old, ok := captures[name]; ok && old != matches[i+1] {
			return fmt.Errorf("%s: 捕获 %s 不一致", path, name)
		}
		captures[name] = matches[i+1]
	}
	return nil
}

// Expand 只替换 JSON 字符串值，保留键、数字和数组顺序。
func Expand(raw json.RawMessage, bindings map[string]string, captures map[string]any) (json.RawMessage, error) {
	v, err := decode(raw)
	if err != nil {
		return nil, err
	}
	v, err = expand(v, bindings, captures)
	if err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

func expand(v any, bindings map[string]string, captures map[string]any) (any, error) {
	switch value := v.(type) {
	case string:
		if wholeCapture(value) {
			if captured, ok := captures[value]; ok {
				return captured, nil
			}
			return nil, fmt.Errorf("尚未捕获 %s", value)
		}
		return expandString(value, bindings, captures)
	case map[string]any:
		for k, child := range value {
			replaced, err := expand(child, bindings, captures)
			if err != nil {
				return nil, err
			}
			value[k] = replaced
		}
	case []any:
		for i, child := range value {
			replaced, err := expand(child, bindings, captures)
			if err != nil {
				return nil, err
			}
			value[i] = replaced
		}
	}
	return v, nil
}

func expandString(s string, bindings map[string]string, captures map[string]any) (string, error) {
	if tokenPattern.MatchString(s) {
		if v, err := decode([]byte(s)); err == nil {
			switch v.(type) {
			case map[string]any, []any:
				expanded, err := expand(v, bindings, captures)
				if err != nil {
					return "", err
				}
				b, err := marshalUnescaped(expanded)
				return string(b), err
			}
		}
	}

	var failure error
	out := tokenPattern.ReplaceAllStringFunc(s, func(token string) string {
		if token == "<any>" {
			return token
		}
		if wholeCapture(token) {
			v, ok := captures[token]
			if !ok {
				failure = fmt.Errorf("尚未捕获 %s", token)
				return ""
			}
			text, err := textValue(v)
			if err != nil {
				failure = err
			}
			return text
		}
		if v, ok := bindings[token]; ok {
			return v
		}
		return token
	})
	return out, failure
}
