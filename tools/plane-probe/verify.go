package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
)

// verifySignature reports whether signatureHex is the lowercase or uppercase
// hex HMAC-SHA256 of body using secret. The MAC is computed over the raw body
// bytes only. Callers must not re-encode JSON before calling this.
func verifySignature(secret, body []byte, signatureHex string) (bool, error) {
	if len(secret) == 0 {
		return false, errors.New("webhook secret is empty")
	}
	got, err := hex.DecodeString(signatureHex)
	if err != nil || len(got) != sha256.Size {
		return false, errors.New("signature is not 64 hexadecimal characters")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	expected := mac.Sum(nil)
	return subtle.ConstantTimeCompare(expected, got) == 1, nil
}
