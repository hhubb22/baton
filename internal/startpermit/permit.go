// Package startpermit 签发并校验短时启动许可。
// 许可和节点连接凭据使用不同受众，不能互相代用。
// 剩余时间按许可请求的单调时钟往返计算，不使用可被用户修改的墙上时钟。
package startpermit

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"baton/internal/identity"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// Issuer 必须与节点连接凭据的签发方一致。
	Issuer = "baton-coordinator"
	// StartAudience 是启动许可的受众。
	StartAudience = "baton-start"
	// NodeAudience 是连接凭据的受众，出现在启动许可里必须拒绝。
	NodeAudience = "baton-node"
	// Purpose 把启动许可和任何其他 JWT 分开。
	Purpose = "start"

	// PermitTTL 是启动许可的最长寿命，并且不能晚于排队到期时间。
	PermitTTL = 5 * time.Second
	// SafetyMargin 是从寿命里扣除的安全余量。扣完后没有正预算就拒绝启动。
	SafetyMargin = time.Second
)

// Claims 是启动许可里可以信任的内容。业务正文不在其中。
type Claims struct {
	NodeID            string
	EmployeeID        string
	TaskID            string
	ExecutionID       string
	StorageGeneration string
	Nonce             string
	RequestHash       []byte
	QueueExpiresAt    time.Time
	IssuedAt          time.Time
	ExpiresAt         time.Time
}

type permitJWT struct {
	jwt.RegisteredClaims
	NodeID            string `json:"node_id"`
	EmployeeID        string `json:"employee_id"`
	TaskID            string `json:"task_id"`
	ExecutionID       string `json:"execution_id"`
	StorageGeneration string `json:"storage_generation"`
	Nonce             string `json:"nonce"`
	RequestSHA256     string `json:"request_sha256"`
	QueueExpiresAt    string `json:"queue_expires_at"`
	IssuedMS          int64  `json:"iat_ms"`
	ExpiresMS         int64  `json:"exp_ms"`
	Purpose           string `json:"purpose"`
}

// Sign 用 Coordinator 私钥签发许可。调用方必须先提交 start_authorized，提交失败不能调用这里。
func Sign(key ed25519.PrivateKey, c Claims) (string, error) {
	if len(key) != ed25519.PrivateKeySize {
		return "", errors.New("没有启动许可签名密钥")
	}
	if err := validateShape(c); err != nil {
		return "", err
	}
	lifetime := c.ExpiresAt.Sub(c.IssuedAt)
	if lifetime <= 0 || lifetime > PermitTTL || c.ExpiresAt.After(c.QueueExpiresAt) {
		return "", errors.New("启动许可有效期无效")
	}
	claims := permitJWT{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Subject:   c.ExecutionID,
			Audience:  jwt.ClaimStrings{StartAudience},
			ExpiresAt: jwt.NewNumericDate(c.ExpiresAt.UTC()),
			IssuedAt:  jwt.NewNumericDate(c.IssuedAt.UTC()),
			ID:        c.Nonce,
		},
		NodeID:            c.NodeID,
		EmployeeID:        c.EmployeeID,
		TaskID:            c.TaskID,
		ExecutionID:       c.ExecutionID,
		StorageGeneration: c.StorageGeneration,
		Nonce:             c.Nonce,
		RequestSHA256:     hex.EncodeToString(c.RequestHash),
		QueueExpiresAt:    c.QueueExpiresAt.UTC().Format(time.RFC3339Nano),
		IssuedMS:          c.IssuedAt.UTC().UnixMilli(),
		ExpiresMS:         c.ExpiresAt.UTC().UnixMilli(),
		Purpose:           Purpose,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signed, err := token.SignedString(key)
	if err != nil {
		return "", errors.New("无法签发启动许可")
	}
	return signed, nil
}

// Verify 检查签名、受众和声明形状。它不把本机墙上时钟和 exp 比较。
// 调用方还要用 Remaining 判断往返之后是否还有正预算，并核对执行身份与存储代次。
func Verify(pub ed25519.PublicKey, token string) (Claims, error) {
	if len(pub) != ed25519.PublicKeySize || strings.TrimSpace(token) == "" {
		return Claims{}, errors.New("启动许可无效")
	}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithStrictDecoding(),
		jwt.WithoutClaimsValidation(),
	)
	parsed, err := parser.ParseWithClaims(token, &permitJWT{}, func(t *jwt.Token) (any, error) {
		if t.Method == nil || t.Method.Alg() != jwt.SigningMethodEdDSA.Alg() {
			return nil, errors.New("启动许可无效")
		}
		return pub, nil
	})
	if err != nil {
		return Claims{}, errors.New("启动许可无效")
	}
	claims, ok := parsed.Claims.(*permitJWT)
	if !ok || !parsed.Valid {
		return Claims{}, errors.New("启动许可无效")
	}
	if claims.Issuer != Issuer || claims.Purpose != Purpose || claims.Subject == "" {
		return Claims{}, errors.New("启动许可无效")
	}
	if len(claims.Audience) != 1 || claims.Audience[0] != StartAudience || claims.Audience[0] == NodeAudience {
		return Claims{}, errors.New("启动许可无效")
	}
	if claims.ID == "" || claims.Nonce == "" || claims.ID != claims.Nonce || claims.Subject != claims.ExecutionID {
		return Claims{}, errors.New("启动许可无效")
	}
	sum, err := hex.DecodeString(claims.RequestSHA256)
	if err != nil || len(sum) != 32 || claims.RequestSHA256 != hex.EncodeToString(sum) {
		return Claims{}, errors.New("启动许可无效")
	}
	queueAt, err := time.Parse(time.RFC3339Nano, claims.QueueExpiresAt)
	if err != nil {
		return Claims{}, errors.New("启动许可无效")
	}
	if claims.IssuedMS <= 0 || claims.ExpiresMS <= claims.IssuedMS {
		return Claims{}, errors.New("启动许可无效")
	}
	issued := time.UnixMilli(claims.IssuedMS).UTC()
	expires := time.UnixMilli(claims.ExpiresMS).UTC()
	out := Claims{
		NodeID:            claims.NodeID,
		EmployeeID:        claims.EmployeeID,
		TaskID:            claims.TaskID,
		ExecutionID:       claims.ExecutionID,
		StorageGeneration: claims.StorageGeneration,
		Nonce:             claims.Nonce,
		RequestHash:       sum,
		QueueExpiresAt:    queueAt.UTC(),
		IssuedAt:          issued,
		ExpiresAt:         expires,
	}
	if err := validateShape(out); err != nil {
		return Claims{}, errors.New("启动许可无效")
	}
	lifetime := out.ExpiresAt.Sub(out.IssuedAt)
	if lifetime <= 0 || lifetime > PermitTTL || out.ExpiresAt.After(out.QueueExpiresAt) {
		return Claims{}, errors.New("启动许可无效")
	}
	return out, nil
}

// Remaining 用许可寿命减去往返耗时和安全余量。结果不是正数时不能启动。
// rtt 必须来自包含休眠时间的单调时钟，不能来自墙上时钟。
func Remaining(lifetime, rtt time.Duration) (time.Duration, bool) {
	if lifetime <= 0 || lifetime > PermitTTL || rtt < 0 {
		return 0, false
	}
	left := lifetime - rtt - SafetyMargin
	if left <= 0 {
		return 0, false
	}
	return left, true
}

func validateShape(c Claims) error {
	for _, id := range []string{c.NodeID, c.EmployeeID, c.TaskID, c.ExecutionID, c.Nonce} {
		if _, err := identity.ParseUUID(id); err != nil {
			return errors.New("启动许可标识不正确")
		}
	}
	if len(c.RequestHash) != 32 {
		return errors.New("启动许可摘要不正确")
	}
	if !validGeneration(c.StorageGeneration) {
		return errors.New("启动许可存储代次不正确")
	}
	if c.IssuedAt.IsZero() || c.ExpiresAt.IsZero() || c.QueueExpiresAt.IsZero() {
		return errors.New("启动许可有效期无效")
	}
	return nil
}

func validGeneration(value string) bool {
	if len(value) < 1 || len(value) > 80 {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
