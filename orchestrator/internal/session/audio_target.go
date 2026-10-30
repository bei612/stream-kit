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
	Epoch           uint64 `json:"epoch"`
	Mode            string `json:"mode"`
	RenderDeviceID  string `json:"render_device_id"`
	CaptureDeviceID string `json:"capture_device_id"`
}

func (target AudioTarget) valid() bool {
	switch target.Mode {
	case "disabled", "upstream":
		return target.RenderDeviceID == "" && target.CaptureDeviceID == ""
	case "local":
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
	claimed := make(map[string]string)
	for id, s := range m.sessions {
		if s.State == StateStopped || s.Audio.Target.Mode != "local" {
			continue
		}
		for _, endpoint := range []string{s.Audio.Target.RenderDeviceID, s.Audio.Target.CaptureDeviceID} {
			if _, exists := claimed[endpoint]; exists {
				return ErrAudioTargetInUse
			}
			claimed[endpoint] = id
		}
	}
	return nil
}

func (m *Manager) checkAudioTargetReservation(next *RenderSession) error {
	if next.State == StateStopped || next.Audio.Target.Mode != "local" {
		return nil
	}
	target := next.Audio.Target
	for id, other := range m.sessions {
		if id == next.ID || other.State == StateStopped || other.Audio.Target.Mode != "local" {
			continue
		}
		bound := other.Audio.Target
		if target.RenderDeviceID == bound.RenderDeviceID || target.RenderDeviceID == bound.CaptureDeviceID ||
			target.CaptureDeviceID == bound.RenderDeviceID || target.CaptureDeviceID == bound.CaptureDeviceID {
			return ErrAudioTargetInUse
		}
	}
	return nil
}

func (m *Manager) UpdateAudioTarget(id string, expectedEpoch uint64, target AudioTarget) error {
	if !target.valid() || expectedEpoch == 0 {
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
