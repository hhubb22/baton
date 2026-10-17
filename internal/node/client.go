package node

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// RegisterRequest 是 batond 向中心兑换节点身份所需的材料。
// EnrollmentToken 只能来自环境变量或受限文件，不能来自 URL 或命令行参数。
type RegisterRequest struct {
	CoordinatorURL  string
	CAFile          string
	EnrollmentToken string
	DisplayName     string
	System          string
	Role            string
	Capabilities    []string
}

// Register 用一次性注册凭据向 Coordinator 注册，并返回节点身份。
func Register(ctx context.Context, req RegisterRequest) (Identity, error) {
	if !ValidSecret(req.EnrollmentToken) {
		return Identity{}, errors.New("注册凭据无效")
	}
	if strings.Contains(req.CoordinatorURL, req.EnrollmentToken) {
		return Identity{}, errors.New("注册凭据不能出现在地址中")
	}
	caps := req.Capabilities
	if caps == nil {
		caps = []string{}
	}
	if err := Validate(req.DisplayName, req.System, req.Role, caps); err != nil {
		return Identity{}, err
	}
	endpoint, err := coordinatorRegisterURL(req.CoordinatorURL)
	if err != nil {
		return Identity{}, err
	}
	if strings.Contains(endpoint, req.EnrollmentToken) {
		return Identity{}, errors.New("注册凭据不能出现在地址中")
	}
	payload, err := json.Marshal(struct {
		EnrollmentToken string   `json:"enrollment_token"`
		DisplayName     string   `json:"display_name"`
		System          string   `json:"system"`
		Role            string   `json:"role"`
		Capabilities    []string `json:"capabilities"`
	}{
		EnrollmentToken: req.EnrollmentToken,
		DisplayName:     req.DisplayName,
		System:          req.System,
		Role:            req.Role,
		Capabilities:    caps,
	})
	if err != nil {
		return Identity{}, errors.New("无法编码注册请求")
	}
	roots, err := rootCAs(req.CAFile)
	if err != nil {
		return Identity{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Identity{}, errors.New("无法创建注册请求")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "batond")
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("拒绝重定向")
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				RootCAs:    roots,
			},
		},
	}
	defer client.CloseIdleConnections()
	resp, err := client.Do(httpReq)
	if err != nil {
		return Identity{}, errors.New("无法连接 Coordinator")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return Identity{}, errors.New("无法读取注册响应")
	}
	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Code == "" {
			return Identity{}, errors.New("注册被拒绝")
		}
		return Identity{}, errors.New("注册被拒绝: " + failure.Code)
	}
	var ident Identity
	if err := json.Unmarshal(raw, &ident); err != nil {
		return Identity{}, errors.New("注册响应无法读取")
	}
	if ident.Capabilities == nil {
		ident.Capabilities = []string{}
	}
	if err := ident.complete(); err != nil {
		return Identity{}, errors.New("注册响应不完整")
	}
	return ident, nil
}

func coordinatorRegisterURL(base string) (string, error) {
	const rejected = "Coordinator 地址必须是不带凭据和查询参数的 https 地址"
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Hostname() == "" || !u.IsAbs() || !strings.EqualFold(u.Scheme, "https") || u.User != nil {
		return "", errors.New(rejected)
	}
	if u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New(rejected)
	}
	u.Scheme = "https"
	u.Path = "/api/v1/nodes/register"
	u.RawQuery = ""
	u.Fragment = ""
	u.Opaque = ""
	return u.String(), nil
}

func rootCAs(caFile string) (*x509.CertPool, error) {
	if strings.TrimSpace(caFile) == "" {
		return nil, nil
	}
	pemBytes, err := os.ReadFile(caFile)
	if err != nil {
		return nil, errors.New("无法读取 TLS CA 文件")
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, errors.New("TLS CA 文件无效")
	}
	return pool, nil
}
