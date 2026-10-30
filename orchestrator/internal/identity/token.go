// Package identity defines typed credentials at the platform trust boundary.
// Management, invitations, connections and media admission are different token
// audiences; possession of one never implies authority in another.
package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	Management = "JWT"
	Invitation = "STREAM-INVITE"
	Connection = "STREAM-CONNECTION"
	Media      = "MEDIA"
)

var ErrCredential = errors.New("invalid or expired credential")

type Header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}
type Claims struct {
	Subject      string `json:"sub"`
	SessionID    string `json:"session_id"`
	ConnectionID string `json:"connection_id,omitempty"`
	IssuedAt     int64  `json:"iat"`
	ExpiresAt    int64  `json:"exp"`
}

func DeriveKey(secret []byte, purpose string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("stream-kit/credential-key/v1\n" + purpose))
	return mac.Sum(nil)
}

func Sign(kind string, claims any, secret []byte) string {
	header, _ := json.Marshal(Header{Alg: "HS256", Typ: kind})
	payload, err := json.Marshal(claims)
	if len(secret) == 0 || err != nil {
		return ""
	}
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func Decode(token, kind string, secret []byte, claims any) error {
	if len(secret) == 0 || len(token) > 8192 {
		return ErrCredential
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ErrCredential
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return ErrCredential
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return ErrCredential
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return ErrCredential
	}
	var header Header
	if json.Unmarshal(headerJSON, &header) != nil || header.Alg != "HS256" || header.Typ != kind {
		return ErrCredential
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, claims) != nil {
		return ErrCredential
	}
	return nil
}

func ValidTime(issued, expires, maxLifetime int64, now time.Time) bool {
	return issued > 0 && issued <= now.Unix()+5 && expires > now.Unix() && expires > issued && expires-issued <= maxLifetime
}

func Verify(token, kind string, secret []byte, now time.Time) (*Claims, error) {
	var claims Claims
	if Decode(token, kind, secret, &claims) != nil || claims.Subject == "" || claims.SessionID == "" {
		return nil, ErrCredential
	}
	var maxLifetime int64
	switch kind {
	case Invitation:
		maxLifetime = 120
		if claims.ConnectionID != "" {
			return nil, ErrCredential
		}
	case Connection:
		maxLifetime = 900
		if claims.ConnectionID == "" {
			return nil, ErrCredential
		}
	default:
		return nil, ErrCredential
	}
	if !ValidTime(claims.IssuedAt, claims.ExpiresAt, maxLifetime, now) {
		return nil, ErrCredential
	}
	return &claims, nil
}
