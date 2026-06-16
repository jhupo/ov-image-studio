package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
)

type Secrets struct {
	key []byte
}

func NewSecrets(secret string) (*Secrets, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return nil, err
	}
	return &Secrets{key: key}, nil
}

func (s *Secrets) Encrypt(value string) ([]byte, []byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return gcm.Seal(nil, nonce, []byte(value), nil), nonce, nil
}

func (s *Secrets) Decrypt(ciphertext []byte, nonce []byte) (string, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	raw, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func Fingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

func MaskKey(value string) string {
	if len(value) <= 10 {
		return "****"
	}
	return value[:3] + "****" + value[len(value)-6:]
}

func decodeSecret(secret string) ([]byte, error) {
	if secret == "" {
		return nil, fmt.Errorf("APP_SECRET is required")
	}
	if decoded, err := base64.StdEncoding.DecodeString(secret); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	sum := sha256.Sum256([]byte(secret))
	return sum[:], nil
}
