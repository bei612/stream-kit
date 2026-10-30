package mediacontrol

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestObservationContractAuthenticationAndBinding(t *testing.T) {
	requestBody, err := os.ReadFile("../../../contracts/media-state/v1.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var request Envelope
	if err := json.Unmarshal(requestBody, &request); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("../../../contracts/media-state/v1.observation.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	body = bytes.TrimSpace(body)
	secret := []byte("contract-test-secret")
	signature := "ef842938a6cf7c7c46e63ac41e50cfa0940e85aae0f971427a316facfa4c7fcb"
	now := request.IssuedAt + 20
	ack, err := decodeAcknowledgement(secret, signature, body, request, now)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(ack)
	if !bytes.Equal(body, encoded) {
		t.Fatal("Go observation differs from Rust fixture")
	}
	for _, test := range []struct {
		name      string
		key       []byte
		signature string
		body      []byte
	}{
		{"wrong key", []byte("other"), signature, body},
		{"missing signature", secret, "", body},
		{"tampered", secret, signature, append(append([]byte{}, body...), ' ')},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeAcknowledgement(test.key, test.signature, test.body, request, now); err == nil {
				t.Fatal("accepted unauthenticated observation")
			}
		})
	}
	newer := request
	newer.IssuedAt++
	if _, err := decodeAcknowledgement(secret, signature, body, newer, now); err == nil {
		t.Fatal("accepted replay for another request")
	}
	if _, err := decodeAcknowledgement(secret, signature, body, request, request.ExpiresAt); err == nil {
		t.Fatal("accepted expired acknowledgement")
	}
	for _, test := range []struct {
		name   string
		change func(*Acknowledgement)
	}{
		{"version", func(a *Acknowledgement) { a.SchemaVersion++ }},
		{"old clock", func(a *Acknowledgement) { a.ObservedAt = request.IssuedAt - 2001 }},
		{"future clock", func(a *Acknowledgement) { a.ObservedAt = now + 2001 }},
		{"missing session", func(a *Acknowledgement) { a.Sessions = nil }},
		{"foreign session", func(a *Acknowledgement) { a.Sessions[0].SessionID = "other" }},
		{"wrong revision", func(a *Acknowledgement) { a.Sessions[0].Revision++ }},
		{"invented state", func(a *Acknowledgement) { a.Sessions[0].MicrophoneTarget.State = "recorded" }},
		{"closed device", func(a *Acknowledgement) { a.Sessions[0].MicrophoneTarget.Device.DeviceOpen = false }},
		{"inactive transport", func(a *Acknowledgement) { a.Sessions[0].UpstreamActive = false }},
	} {
		t.Run(test.name, func(t *testing.T) {
			var changed Acknowledgement
			_ = json.Unmarshal(body, &changed)
			test.change(&changed)
			data, _ := json.Marshal(changed)
			mac := hmac.New(sha256.New, secret)
			mac.Write([]byte(ObservationSigningContext))
			mac.Write(data)
			if _, err := decodeAcknowledgement(secret, hex.EncodeToString(mac.Sum(nil)), data, request, now); err == nil {
				t.Fatal("accepted inconsistent observation")
			}
		})
	}
}

func TestObservationFreshnessAndOwnership(t *testing.T) {
	now := time.Now().UnixMilli()
	message := "device lost"
	p := &Publisher{status: Status{Reachable: true, AcknowledgedAt: now, LeaseExpiresAt: now + 10000,
		Observations: map[string]SessionObservation{"s": {SessionID: "s", MicrophoneTarget: TargetObservation{State: "device_failed", Device: &TargetDeviceStatus{Error: &message}}}}}}
	got := p.Status()
	if !got.ObservationsValid {
		t.Fatal("fresh observation hidden")
	}
	*got.Observations["s"].MicrophoneTarget.Device.Error = "changed"
	if *p.Status().Observations["s"].MicrophoneTarget.Device.Error != "device lost" {
		t.Fatal("mutable runtime state escaped")
	}
	p.status.AcknowledgedAt -= observationFreshnessMS
	if p.Status().ObservationsValid {
		t.Fatal("stale observation reported current")
	}
}
