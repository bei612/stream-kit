package mediacontrol

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/session"
	"io"
)

const ObservationSigningContext = "stream-kit/media-observation/v2\n"
const observationMaxBytes = 1 << 20
const observationFreshnessMS = 3000

type TargetDeviceStatus struct {
	DeviceOpen         bool    `json:"device_open"`
	DeviceSampleFrames uint64  `json:"device_sample_frames"`
	DroppedFrames      uint64  `json:"dropped_frames"`
	XRuns              uint64  `json:"xruns"`
	RealtimeDenied     bool    `json:"realtime_denied"`
	Error              *string `json:"error"`
}
type TargetObservation struct {
	Epoch  uint64              `json:"epoch"`
	State  string              `json:"state"`
	Device *TargetDeviceStatus `json:"device"`
	Error  *string             `json:"error"`
}
type SessionObservation struct {
	SessionID        string            `json:"session_id"`
	Revision         uint64            `json:"revision"`
	UpstreamActive   bool              `json:"upstream_active"`
	Subscribers      uint32            `json:"subscribers"`
	MicrophoneTarget TargetObservation `json:"microphone_target"`
}
type Acknowledgement struct {
	SchemaVersion uint32               `json:"schema_version"`
	StateIssuedAt int64                `json:"state_issued_at_ms"`
	ObservedAt    int64                `json:"observed_at_ms"`
	Sessions      []SessionObservation `json:"sessions"`
}

func decodeAcknowledgement(secret []byte, signature string, body []byte, request Envelope, now int64) (Acknowledgement, error) {
	var ack Acknowledgement
	rawSignature, err := hex.DecodeString(signature)
	if err != nil || len(rawSignature) != sha256.Size || len(body) > observationMaxBytes {
		return ack, fmt.Errorf("invalid media observation signature or size")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(ObservationSigningContext))
	mac.Write(body)
	if len(secret) == 0 || !hmac.Equal(rawSignature, mac.Sum(nil)) {
		return ack, fmt.Errorf("unauthenticated media observation")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ack); err != nil {
		return ack, fmt.Errorf("invalid media observation: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ack, fmt.Errorf("trailing media observation data")
	}
	if ack.SchemaVersion != 2 || ack.StateIssuedAt != request.IssuedAt ||
		ack.ObservedAt < request.IssuedAt-2000 || ack.ObservedAt > now+2000 ||
		now >= request.ExpiresAt || len(ack.Sessions) != len(request.Sessions) {
		return ack, fmt.Errorf("mismatched or stale media observation")
	}
	expected := make(map[string]uint64, len(request.Sessions))
	targets := make(map[string]session.AudioTarget, len(request.Sessions))
	for _, session := range request.Sessions {
		expected[session.ID] = session.Revision
		targets[session.ID] = session.Audio.Target
	}
	for _, observed := range ack.Sessions {
		revision, ok := expected[observed.SessionID]
		if !ok || revision != observed.Revision {
			return ack, fmt.Errorf("media observation session/revision mismatch")
		}
		delete(expected, observed.SessionID)
		target := observed.MicrophoneTarget
		desired := targets[observed.SessionID]
		if target.Epoch != desired.Epoch {
			return ack, fmt.Errorf("media observation target generation mismatch")
		}
		valid := false
		switch target.State {
		case "unconfigured":
			valid = target.Device == nil && desired.Mode == "upstream"
		case "pending":
			valid = observed.UpstreamActive && target.Device == nil
		case "disabled":
			valid = desired.Mode == "disabled" && target.Device == nil
		case "idle":
			valid = !observed.UpstreamActive && target.Device == nil
		case "remote_transport":
			valid = observed.UpstreamActive && desired.Mode == "remote" && target.Device == nil
		case "upstream_transport":
			valid = observed.UpstreamActive && desired.Mode == "upstream" && target.Device == nil
		case "device_open":
			valid = observed.UpstreamActive && desired.Mode == "local" && target.Device != nil && target.Device.DeviceOpen && target.Device.Error == nil
		case "device_failed":
			valid = observed.UpstreamActive && (target.Error != nil || (target.Device != nil && !target.Device.DeviceOpen))
		}
		if target.State != "device_failed" && target.Error != nil {
			valid = false
		}
		if !valid {
			return ack, fmt.Errorf("inconsistent microphone target observation")
		}
	}
	return ack, nil
}

func cloneObservation(source SessionObservation) SessionObservation {
	if source.MicrophoneTarget.Error != nil {
		message := *source.MicrophoneTarget.Error
		source.MicrophoneTarget.Error = &message
	}
	if source.MicrophoneTarget.Device != nil {
		device := *source.MicrophoneTarget.Device
		if device.Error != nil {
			message := *device.Error
			device.Error = &message
		}
		source.MicrophoneTarget.Device = &device
	}
	return source
}
