package session

import (
	"errors"
	"strings"
	"unicode"
)

var ErrAudioTargetChanged = errors.New("audio target changed since the command was prepared")
var ErrAudioTargetInUse = errors.New("audio endpoint is reserved by another session")

// AudioTarget is durable desired state. Epoch is independent of heartbeats and
// controller changes; it also gives an explicit retry a new generation.
type AudioTarget struct {
	NodeID          string `json:"node_id,omitempty"`
	Epoch           uint64 `json:"epoch"`
	Mode            string `json:"mode"`
	RenderDeviceID  string `json:"render_device_id"`
	CaptureDeviceID string `json:"capture_device_id"`
}

func (target AudioTarget) Valid() bool {
	if target.Mode == "remote" {
		if target.NodeID == "" || target.NodeID == "primary" || len(target.NodeID) > 128 {
			return false
		}
		for _, c := range target.NodeID {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return false
			}
		}
	} else if target.NodeID != "" {
		return false
	}
	switch target.Mode {
	case "disabled", "upstream":
		return target.RenderDeviceID == "" && target.CaptureDeviceID == ""
	case "local", "remote":
		return validDeviceID(target.RenderDeviceID) && validDeviceID(target.CaptureDeviceID) && target.RenderDeviceID != target.CaptureDeviceID
	default:
		return false
	}
}

func validDeviceID(id string) bool {
	return id != "" && len(id) <= 4096 && strings.TrimSpace(id) == id && !strings.ContainsFunc(id, unicode.IsControl)
}

// Startup validates all persisted reservations as one set before making any
// session available. Stopping sessions retain ownership until fully stopped.
func (m *Manager) validateAudioTargets() error {
	claimed := make(map[[2]string]string)
	for id, s := range m.sessions {
		if s.State == StateStopped || (s.Audio.Target.Mode != "local" && s.Audio.Target.Mode != "remote") {
			continue
		}
		for _, endpoint := range []string{s.Audio.Target.RenderDeviceID, s.Audio.Target.CaptureDeviceID} {
			if _, exists := claimed[[2]string{s.Audio.Target.NodeID, endpoint}]; exists {
				return ErrAudioTargetInUse
			}
			claimed[[2]string{s.Audio.Target.NodeID, endpoint}] = id
		}
	}
	return nil
}

func (m *Manager) checkAudioTargetReservation(next *RenderSession) error {
	if next.State == StateStopped || (next.Audio.Target.Mode != "local" && next.Audio.Target.Mode != "remote") {
		return nil
	}
	target := next.Audio.Target
	for id, other := range m.sessions {
		if id == next.ID || other.State == StateStopped || (other.Audio.Target.Mode != "local" && other.Audio.Target.Mode != "remote") {
			continue
		}
		bound := other.Audio.Target
		if target.NodeID != bound.NodeID {
			continue
		}
		if target.RenderDeviceID == bound.RenderDeviceID || target.RenderDeviceID == bound.CaptureDeviceID ||
			target.CaptureDeviceID == bound.RenderDeviceID || target.CaptureDeviceID == bound.CaptureDeviceID {
			return ErrAudioTargetInUse
		}
	}
	return nil
}

func (m *Manager) UpdateAudioTarget(id string, expectedEpoch uint64, target AudioTarget) error {
	if !target.Valid() || expectedEpoch == 0 {
		return ErrInvalidState
	}
	return m.mutate(id, "stream_audio_changed", func(s *RenderSession) error {
		if s.State == StateStopping || s.State == StateStopped {
			return ErrInvalidState
		}
		if s.Audio.Target.Epoch != expectedEpoch {
			return ErrAudioTargetChanged
		}
		// Reapplying an identical selection is an explicit device recovery request.
		target.Epoch = s.Revision + 1
		s.Audio.Target = target
		return nil
	})
}
