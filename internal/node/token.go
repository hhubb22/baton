package node

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/privatefile"
	"baton/internal/startpermit"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// Issuer 是节点连接凭据的签发方。私钥只在 Coordinator。
	Issuer = "baton-coordinator"
	// NodeAudience 是节点连接凭据的受众，不能当作启动许可使用。
	NodeAudience = "baton-node"
	// StartAudience 预留给启动许可，Gateway 不接受这个受众的连接凭据。
	StartAudience = "baton-start"
)

// TokenSigner 用 Coordinator 的私钥签发节点连接凭据，并能给出验签公钥。
type TokenSigner interface {
	SignNodeToken(nodeID, employeeID, credentialID string, expires time.Time) (string, error)
	PublicKey() (ed25519.PublicKey, error)
}

// NodeClaims 是验签后可以信任的连接凭据内容。业务正文不在其中。
type NodeClaims struct {
	NodeID       string
	EmployeeID   string
	CredentialID string
	ExpiresAt    time.Time
}

// Signer 持有 Ed25519 私钥。副本只复制切片头，密钥材料仍在原数组里。
type Signer struct {
	key ed25519.PrivateKey
}

type nodeJWT struct {
	jwt.RegisteredClaims
	NodeID       string `json:"node_id"`
	EmployeeID   string `json:"employee_id"`
	CredentialID string `json:"credential_id"`
}

// GenerateSigner 生成一把新的节点签名密钥。
func GenerateSigner() (Signer, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Signer{}, errors.New("无法生成节点签名密钥")
	}
	return Signer{key: priv}, nil
}

// LoadSigner 读取 PKCS#8 PEM。文件必须只有当前用户可读，也不能是符号链接。
func LoadSigner(path string) (Signer, error) {
	raw, err := privatefile.ReadFile(path)
	if err != nil {
		return Signer{}, errors.New("无法读取节点签名密钥")
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" {
		return Signer{}, errors.New("节点签名密钥无效")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return Signer{}, errors.New("节点签名密钥无效")
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return Signer{}, errors.New("节点签名密钥无效")
	}
	return Signer{key: priv}, nil
}

// WriteFile 将 PKCS#8 私钥原子写入仅当前用户可访问的文件。
func (s Signer) WriteFile(path string) error {
	raw, err := s.MarshalPKCS8PEM()
	if err != nil {
		return err
	}
	return privatefile.WriteFile(path, raw)
}

// MarshalPKCS8PEM 导出私钥；保存到磁盘应使用 WriteFile。
func (s Signer) MarshalPKCS8PEM() ([]byte, error) {
	if len(s.key) == 0 {
		return nil, errors.New("没有节点签名密钥")
	}
	der, err := x509.MarshalPKCS8PrivateKey(s.key)
	if err != nil {
		return nil, errors.New("无法编码节点签名密钥")
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// ValidSigningPublicKey 检查身份文件里的启动许可验签公钥。空字符串表示旧身份，不能用来启动。
func ValidSigningPublicKey(raw string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	return err == nil && len(decoded) == ed25519.PublicKeySize
}

// StartPublicKey 取出注册时钉住的 Coordinator 公钥。没有公钥时不能校验启动许可。
func (id Identity) StartPublicKey() (ed25519.PublicKey, error) {
	if !ValidSigningPublicKey(id.SigningPublicKey) {
		return nil, errors.New("没有启动许可公钥")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(id.SigningPublicKey)
	if err != nil {
		return nil, errors.New("没有启动许可公钥")
	}
	return ed25519.PublicKey(decoded), nil
}

// PublicKey 返回 Gateway 用来验签的公钥。
func (s Signer) PublicKey() (ed25519.PublicKey, error) {
	if len(s.key) == 0 {
		return nil, errors.New("没有节点签名密钥")
	}
	pub, ok := s.key.Public().(ed25519.PublicKey)
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("节点签名密钥无效")
	}
	return pub, nil
}

// SignStartPermit 签发启动许可。调用方必须已经提交 start_authorized。
func (s Signer) SignStartPermit(c startpermit.Claims) (string, error) {
	if len(s.key) == 0 {
		return "", errors.New("没有节点签名密钥")
	}
	return startpermit.Sign(s.key, c)
}

// SignNodeToken 签发绑定节点、员工、credential_id、签发方、受众和有效期的 JWT。
func (s Signer) SignNodeToken(nodeID, employeeID, credentialID string, expires time.Time) (string, error) {
	if len(s.key) == 0 {
		return "", errors.New("没有节点签名密钥")
	}
	nodeID, err := identity.ParseUUID(nodeID)
	if err != nil {
		return "", errors.New("节点标识不正确")
	}
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return "", errors.New("员工标识不正确")
	}
	credentialID, err = identity.ParseUUID(credentialID)
	if err != nil {
		return "", errors.New("凭据标识不正确")
	}
	if expires.IsZero() {
		return "", errors.New("节点凭据有效期无效")
	}
	now := time.Now().UTC()
	claims := nodeJWT{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Subject:   nodeID,
			Audience:  jwt.ClaimStrings{NodeAudience},
			ExpiresAt: jwt.NewNumericDate(expires.UTC()),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        credentialID,
		},
		NodeID:       nodeID,
		EmployeeID:   employeeID,
		CredentialID: credentialID,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signed, err := token.SignedString(s.key)
	if err != nil || !ValidNodeToken(signed) {
		return "", errors.New("无法签发节点凭据")
	}
	return signed, nil
}

// VerifyNodeToken 用公钥检查签名、受众、签发方、有效期，以及声明内部是否一致。
func VerifyNodeToken(pub ed25519.PublicKey, token string, now time.Time) (NodeClaims, error) {
	if len(pub) != ed25519.PublicKeySize || !ValidNodeToken(token) {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	if now.IsZero() {
		now = time.Now()
	}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(NodeAudience),
		jwt.WithExpirationRequired(),
		jwt.WithStrictDecoding(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	parsed, err := parser.ParseWithClaims(token, &nodeJWT{}, func(t *jwt.Token) (any, error) {
		if t.Method == nil || t.Method.Alg() != jwt.SigningMethodEdDSA.Alg() {
			return nil, errors.New("节点凭据无效")
		}
		return pub, nil
	})
	if err != nil {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	claims, ok := parsed.Claims.(*nodeJWT)
	if !ok || !parsed.Valid {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	nodeID, err := identity.ParseUUID(claims.NodeID)
	if err != nil || nodeID != claims.Subject {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	employeeID, err := identity.ParseUUID(claims.EmployeeID)
	if err != nil {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	credentialID, err := identity.ParseUUID(claims.CredentialID)
	if err != nil || credentialID != claims.ID {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	if claims.ExpiresAt == nil {
		return NodeClaims{}, errors.New("节点凭据无效")
	}
	return NodeClaims{
		NodeID:       nodeID,
		EmployeeID:   employeeID,
		CredentialID: credentialID,
		ExpiresAt:    claims.ExpiresAt.Time.UTC(),
	}, nil
}
