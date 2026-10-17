package startpermit

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"baton/internal/identity"

	"github.com/golang-jwt/jwt/v5"
)

func TestRemainingUsesBudgetNotWallClock(t *testing.T) {
	clock := NewManual(time.Unix(1_700_000_000, 0))
	start, err := clock.Mono()
	if err != nil {
		t.Fatal(err)
	}
	clock.Suspend(6 * time.Second)
	end, err := clock.Mono()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := Remaining(PermitTTL, end-start); ok {
		t.Fatal("暂停超过许可寿命后仍然留下了预算")
	}
	jumped := NewManual(time.Unix(1_700_000_000, 0))
	before, _ := jumped.Mono()
	wall := jumped.Wall()
	jumped.JumpWall(24 * time.Hour)
	after, _ := jumped.Mono()
	if before != after || !jumped.Wall().Equal(wall.Add(24*time.Hour)) {
		t.Fatal("墙上时钟跳变改变了单调时钟")
	}
	if left, ok := Remaining(PermitTTL, 0); !ok || left != PermitTTL-SafetyMargin {
		t.Fatalf("零往返预算 = %s %v", left, ok)
	}
	if _, ok := Remaining(PermitTTL, PermitTTL-SafetyMargin); ok {
		t.Fatal("扣完安全余量后的零预算被接受")
	}
	if _, ok := Remaining(PermitTTL+time.Millisecond, 0); ok {
		t.Fatal("超过 5 秒的寿命被接受")
	}
	if _, ok := Remaining(0, 0); ok {
		t.Fatal("空寿命被接受")
	}
}

func TestVerifyRejectsOtherAudienceAndBindsExecution(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	good := sampleClaims(t)
	signed, err := Sign(priv, good)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(pub, signed)
	if err != nil || got.ExecutionID != good.ExecutionID || got.StorageGeneration != good.StorageGeneration || got.Nonce != good.Nonce {
		t.Fatalf("验签结果不正确: %+v %v", got, err)
	}
	nodeTok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"iss": Issuer, "sub": good.NodeID, "aud": []string{NodeAudience},
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "jti": good.Nonce,
		"node_id": good.NodeID, "purpose": "connect",
	})
	asNode, err := nodeTok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(pub, asNode); err == nil {
		t.Fatal("连接凭据被接受为启动许可")
	}
	other, err := Sign(priv, func() Claims {
		c := good
		c.ExpiresAt = c.IssuedAt.Add(PermitTTL + time.Second)
		return c
	}())
	if err == nil || other != "" {
		t.Fatal("超长许可被签发")
	}
}

func sampleClaims(t *testing.T) Claims {
	t.Helper()
	issued := time.Now().UTC().Truncate(time.Millisecond)
	return Claims{
		NodeID: mustID(t), EmployeeID: mustID(t), TaskID: mustID(t), ExecutionID: mustID(t),
		StorageGeneration: mustID(t), Nonce: mustID(t), RequestHash: bytes32(9),
		QueueExpiresAt: issued.Add(time.Minute),
		IssuedAt:       issued,
		ExpiresAt:      issued.Add(PermitTTL),
	}
}

func mustID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func bytes32(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}
