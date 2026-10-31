package identity

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

const Microphone = "STREAM-MICROPHONE"
const microphonePurpose = "stream-kit/remote-microphone/v1"
const MicrophoneLifetime = 5 * time.Second

// MicrophoneBinding must originate from a current authoritative session and
// registered node identities. A browser request must never populate this value.
type MicrophoneBinding struct {
	SourceNodeID     string `json:"source_node_id"`
	TargetNodeID     string `json:"target_node_id"`
	TargetInstanceID string `json:"target_instance_id"`
	SessionID        string `json:"session_id"`
	ConnectionID     string `json:"connection_id"`
	HostID           uint32 `json:"host_id"`
	AppID            uint32 `json:"app_id"`
	TargetEpoch      uint64 `json:"target_epoch"`
	ControlEpoch     uint64 `json:"control_epoch"`
}

type MicrophoneClaims struct {
	MicrophoneBinding
	Purpose   string `json:"purpose"`
	Nonce     string `json:"jti"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func validMicrophoneID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (binding MicrophoneBinding) valid() bool {
	return validMicrophoneID(binding.SourceNodeID) && validMicrophoneID(binding.TargetNodeID) &&
		validMicrophoneID(binding.TargetInstanceID) &&
		binding.SourceNodeID != binding.TargetNodeID && validMicrophoneID(binding.SessionID) &&
		validMicrophoneID(binding.ConnectionID) && binding.TargetEpoch != 0 && binding.ControlEpoch != 0
}

// MicrophoneNodeKey derives the target node's verification key. Provision only
// this derived key to that node, never the control plane's root secret.
func MicrophoneNodeKey(root []byte, targetNodeID string) ([]byte, error) {
	if len(root) < 32 || !validMicrophoneID(targetNodeID) {
		return nil, ErrCredential
	}
	return DeriveKey(root, microphonePurpose+"\n"+targetNodeID), nil
}

// IssueMicrophone creates a short-lived admission credential, not a runtime
// lease. The receiver must consume jti once and check its live signed snapshot
// for every frame. No HTTP endpoint exposes this issuer before node integration.
func IssueMicrophone(binding MicrophoneBinding, root []byte, now time.Time) (string, error) {
	if !binding.valid() || now.Unix() <= 0 || now.Unix() > 1<<62 {
		return "", ErrCredential
	}
	key, err := MicrophoneNodeKey(root, binding.TargetNodeID)
	if err != nil {
		return "", err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	claims := MicrophoneClaims{binding, microphonePurpose, hex.EncodeToString(nonce[:]), now.Unix(), now.Add(MicrophoneLifetime).Unix()}
	return Sign(Microphone, claims, key), nil
}

// VerifyMicrophone checks cryptographic admission and exact expected binding.
// It deliberately does not consume nonces or grant audio/device authority.
func VerifyMicrophone(token string, nodeKey []byte, expected MicrophoneBinding, now time.Time) (*MicrophoneClaims, error) {
	var claims MicrophoneClaims
	if len(nodeKey) < 32 || !expected.valid() || Decode(token, Microphone, nodeKey, &claims) != nil ||
		claims.MicrophoneBinding != expected || claims.Purpose != microphonePurpose ||
		claims.IssuedAt <= 0 || claims.IssuedAt > now.Unix() || claims.ExpiresAt <= now.Unix() ||
		claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > int64(MicrophoneLifetime/time.Second) {
		return nil, ErrCredential
	}
	nonce, err := hex.DecodeString(claims.Nonce)
	if err != nil || len(nonce) != 16 || hex.EncodeToString(nonce) != claims.Nonce {
		return nil, ErrCredential
	}
	return &claims, nil
}
