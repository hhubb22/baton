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
	"baton/internal/privatefiletest"

	"github.com/golang-jwt/jwt/v5"
)

func TestLoadOrCreateSigner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "node-signing.key")
	signer, created, err := LoadOrCreateSigner(path)
	if err != nil || !created {
		t.Fatalf("生成签名密钥: created=%t err=%v", created, err)
	}
	privatefiletest.AssertPrivate(t, path)
	privatefiletest.AssertPrivate(t, filepath.Dir(path))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	loaded, created, err := LoadOrCreateSigner(path)
	if err != nil || created || !bytes.Equal(signer.key, loaded.key) {
		t.Fatalf("重新加载签名密钥: created=%t err=%v", created, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("已有密钥被改写")
	}
	for _, kind := range []string{"loose", "corrupt", "symlink", "dangling", "directory"} {
		t.Run(kind, func(t *testing.T) {
			bad := filepath.Join(t.TempDir(), "key")
			switch kind {
			case "loose":
				if err := signer.WriteFile(bad); err != nil {
					t.Fatal(err)
				}
				privatefiletest.MakePublic(t, bad)
			case "corrupt":
				if err := os.WriteFile(bad, []byte("invalid"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink", "dangling":
				target := path
				if kind == "dangling" {
					target = filepath.Join(t.TempDir(), "missing")
				}
				if err := os.Symlink(target, bad); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(bad, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if _, created, err := LoadOrCreateSigner(bad); err == nil || created {
				t.Fatalf("接受不安全或无效的密钥: created=%t err=%v", created, err)
			}
		})
	}
}

func TestLoadOrCreateSignerInCurrentDirectory(t *testing.T) {
	t.Chdir(t.TempDir())
	if _, created, err := LoadOrCreateSigner("node-signing.key"); err != nil || !created {
		t.Fatalf("生成默认密钥: created=%t err=%v", created, err)
	}
}

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
			Audience:  jwt.ClaimStrings{"other-audience"},
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
		t.Fatal("其他受众的凭据被接受为连接凭据")
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
	privatefiletest.MakePublic(t, loose)
	if _, err := LoadSigner(loose); err == nil {
		t.Fatal("其他用户可读的密钥被接受")
	}
	tight := filepath.Join(dir, "tight.pem")
	if err := signer.WriteFile(tight); err != nil {
		t.Fatal(err)
	}
	privatefiletest.AssertPrivate(t, tight)
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
