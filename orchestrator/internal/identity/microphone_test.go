package identity

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMicrophoneProtocolFixture(t *testing.T) {
	var fixture struct {
		TestOnly bool             `json:"test_only"`
		Root     string           `json:"root_secret"`
		Key      string           `json:"node_key_hex"`
		Now      int64            `json:"now"`
		Claims   MicrophoneClaims `json:"claims"`
		Token    string           `json:"token"`
	}
	data, err := os.ReadFile("../../../contracts/audio-devices/remote-microphone-v1.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil || !fixture.TestOnly {
		t.Fatal("invalid public fixture", err)
	}
	key, err := MicrophoneNodeKey([]byte(fixture.Root), fixture.Claims.TargetNodeID)
	if err != nil || hex.EncodeToString(key) != fixture.Key {
		t.Fatal("node derivation mismatch", err)
	}
	if Sign(Microphone, fixture.Claims, key) != fixture.Token {
		t.Fatal("signed protocol fixture differs")
	}
	if _, err := VerifyMicrophone(fixture.Token, key, fixture.Claims.MicrophoneBinding, time.Unix(fixture.Now, 0)); err != nil {
		t.Fatal(err)
	}
}

func TestMicrophoneAdmissionBindingAndAudience(t *testing.T) {
	now := time.Unix(1700000000, 0)
	root := []byte(strings.Repeat("r", 32))
	binding := MicrophoneBinding{"gateway-a", "renderer-b", "boot-b", "session-a", "controller-a", 10, 20, 3, 4}
	key, err := MicrophoneNodeKey(root, binding.TargetNodeID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := IssueMicrophone(binding, root, now)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := VerifyMicrophone(token, key, binding, now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := IssueMicrophone(binding, root, now)
	if err != nil || second == token {
		t.Fatal("admissions must have unique nonces", err)
	}
	for _, mutate := range []func(*MicrophoneBinding){
		func(b *MicrophoneBinding) { b.SourceNodeID = "gateway-c" },
		func(b *MicrophoneBinding) { b.TargetNodeID = "renderer-c" },
		func(b *MicrophoneBinding) { b.TargetInstanceID = "boot-c" },
		func(b *MicrophoneBinding) { b.SessionID = "session-c" },
		func(b *MicrophoneBinding) { b.ConnectionID = "controller-c" },
		func(b *MicrophoneBinding) { b.HostID++ },
		func(b *MicrophoneBinding) { b.AppID++ },
		func(b *MicrophoneBinding) { b.TargetEpoch++ },
		func(b *MicrophoneBinding) { b.ControlEpoch++ },
	} {
		expected := binding
		mutate(&expected)
		if _, err := VerifyMicrophone(token, key, expected, now); err == nil {
			t.Fatal("mismatched binding accepted")
		}
	}
	for _, kind := range []string{Management, Invitation, Connection, Media} {
		if _, err := VerifyMicrophone(Sign(kind, claims, key), key, binding, now); err == nil {
			t.Fatal("wrong audience accepted")
		}
		if Decode(token, kind, key, &Claims{}) == nil {
			t.Fatal("microphone token accepted by another audience")
		}
	}
	otherKey, _ := MicrophoneNodeKey(root, "renderer-c")
	for _, wrong := range [][]byte{root, otherKey, nil} {
		if _, err := VerifyMicrophone(token, wrong, binding, now); err == nil {
			t.Fatal("wrong node key accepted")
		}
	}
	for _, when := range []time.Time{now.Add(-time.Second), now.Add(MicrophoneLifetime)} {
		if _, err := VerifyMicrophone(token, key, binding, when); err == nil {
			t.Fatal("invalid time accepted")
		}
	}
	for _, mutate := range []func(*MicrophoneClaims){
		func(c *MicrophoneClaims) { c.ExpiresAt++ },
		func(c *MicrophoneClaims) { c.Purpose = "stream-media" },
		func(c *MicrophoneClaims) { c.Nonce = "short" },
		func(c *MicrophoneClaims) { c.Nonce = strings.Repeat("A", 32) },
	} {
		changed := *claims
		mutate(&changed)
		if _, err := VerifyMicrophone(Sign(Microphone, changed, key), key, binding, now); err == nil {
			t.Fatal("invalid signed claims accepted")
		}
	}
}
