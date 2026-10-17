package node

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/identity"

	"github.com/golang-jwt/jwt/v5"
)

func TestNodeTokenRoundTripAndRejection(t *testing.T) {
	signer, err := GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	pub, err := signer.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	nodeID := mustUUID(t)
	employeeID := mustUUID(t)
	credentialID := mustUUID(t)
	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	token, err := signer.SignNodeToken(nodeID, employeeID, credentialID, expires)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := VerifyNodeToken(pub, token, time.Now())
	if err != nil || claims.NodeID != nodeID || claims.EmployeeID != employeeID || claims.CredentialID != credentialID {
		t.Fatalf("验签结果不正确: %+v %v", claims, err)
	}
	other, err := GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	otherPub, err := other.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyNodeToken(otherPub, token, time.Now()); err == nil {
		t.Fatal("其他密钥通过了验签")
	}
	if _, err := VerifyNodeToken(pub, token, expires.Add(time.Second)); err == nil {
		t.Fatal("过期凭据通过了验签")
	}
	parts := strings.Split(token, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sig[len(sig)/2] ^= 0xff
	parts[2] = base64.RawURLEncoding.EncodeToString(sig)
	if _, err := VerifyNodeToken(pub, strings.Join(parts, "."), time.Now()); err == nil {
		t.Fatal("篡改后的签名通过了验签")
	}
	originalSig := strings.Split(token, ".")[2]
	padded := signatureWithPaddingBit(t, originalSig)
	loose, err := base64.RawURLEncoding.DecodeString(padded)
	canonical, err2 := base64.RawURLEncoding.DecodeString(originalSig)
	if err != nil || err2 != nil || !bytes.Equal(loose, canonical) {
		t.Fatal("填充位改写改变了非严格解码结果")
	}
	parts = strings.Split(token, ".")
	parts[2] = padded
	if _, err := VerifyNodeToken(pub, strings.Join(parts, "."), time.Now()); err == nil {
		t.Fatal("只改末字符填充位的签名通过了验签")
	}

	start := nodeJWT{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Subject:   nodeID,
			Audience:  jwt.ClaimStrings{StartAudience},
			ExpiresAt: jwt.NewNumericDate(expires),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ID:        credentialID,
		},
		NodeID: nodeID, EmployeeID: employeeID, CredentialID: credentialID,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, start).SignedString(signer.key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyNodeToken(pub, signed, time.Now()); err == nil {
		t.Fatal("启动许可被接受为连接凭据")
	}
}

func TestLoadSignerRejectsLooseFileAndSymlink(t *testing.T) {
	dir := t.TempDir()
	signer, err := GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	pemBytes, err := signer.MarshalPKCS8PEM()
	if err != nil {
		t.Fatal(err)
	}
	loose := filepath.Join(dir, "loose.pem")
	if err := os.WriteFile(loose, pemBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSigner(loose); err == nil {
		t.Fatal("其他用户可读的密钥被接受")
	}
	tight := filepath.Join(dir, "tight.pem")
	if err := os.WriteFile(tight, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSigner(tight)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loaded.PublicKey(); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.pem")
	if err := os.Symlink(tight, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSigner(link); err == nil {
		t.Fatal("符号链接密钥被接受")
	}
}

// signatureWithPaddingBit 只改签名段末字符的填充位。Ed25519 签名是 64 字节，
// 末字符的低 4 位不进入解码结果；非严格解码会忽略它们。
func signatureWithPaddingBit(t *testing.T, sig string) string {
	t.Helper()
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, sig[len(sig)-1])
	if last < 0 {
		t.Fatal("签名末字符不在 base64url 字母表中")
	}
	altered := last ^ 0x01
	if altered == last || altered > 63 {
		t.Fatal("无法改写填充位")
	}
	return sig[:len(sig)-1] + string(alphabet[altered])
}

func mustUUID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
