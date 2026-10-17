package main

import "testing"

func TestVerifySignatureRawBody(t *testing.T) {
	secret := []byte("example-webhook-secret")
	body := []byte(`{"event":"issue","name":"\u63a2\u9488"}`)
	const want = "e2ed972d1c71a2e477bb61f5a868db33e025ee9dff5d52cbc8e55e100a4fe3da"
	ok, err := verifySignature(secret, body, want)
	if err != nil || !ok {
		t.Fatalf("原始正文应通过校验 ok=%v err=%v", ok, err)
	}
	ok, err = verifySignature(secret, body, "E2ED972D1C71A2E477BB61F5A868DB33E025EE9DFF5D52CBC8E55E100A4FE3DA")
	if err != nil || !ok {
		t.Fatalf("大写十六进制应通过校验 ok=%v err=%v", ok, err)
	}
}

func TestVerifySignatureRejectsReserializationAndWrongKey(t *testing.T) {
	secret := []byte("example-webhook-secret")
	spaced := []byte(`{"a": 1}`)
	const spacedSig = "514097be26dd10bd804a0f47c9dc98bfd6ee325b9fe66a595e5ee56cc7243855"
	ok, err := verifySignature(secret, spaced, spacedSig)
	if err != nil || !ok {
		t.Fatalf("带空格正文应通过校验")
	}
	ok, err = verifySignature(secret, []byte(`{"a":1}`), spacedSig)
	if err != nil || ok {
		t.Fatalf("紧凑重编码不得通过校验 ok=%v err=%v", ok, err)
	}
	ok, err = verifySignature([]byte("other-secret"), spaced, spacedSig)
	if err != nil || ok {
		t.Fatalf("错误密钥不得通过校验")
	}
	if _, err = verifySignature(nil, spaced, spacedSig); err == nil {
		t.Fatal("空密钥应返回错误")
	}
	if _, err = verifySignature(secret, spaced, "abcd"); err == nil {
		t.Fatal("短签名应返回错误")
	}
}
