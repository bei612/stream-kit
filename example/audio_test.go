package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnalysisKeepsCaptureStateAndRejectsPreviousRecording(t *testing.T) {
	p := &audioProbe{state: audioState{State: "completed", InputState: "completed", Captured: 48000}, lastCaptureID: 4}
	analysis := json.RawMessage(`{"frequency_hz":1499,"sample_rate":48000,"analyzed_frames":48000,"mean_amplitude":0.08,"peak_amplitude":0.09}`)
	p.applyResponse(probeMessage{ID: 3, Data: analysis})
	if p.analysis != nil {
		t.Fatal("Accepted analysis from a prior recording")
	}
	p.applyResponse(probeMessage{ID: 5, Data: analysis})
	if p.analysis == nil || p.analysis.Mean != 0.08 || p.analysis.Frequency != 1499 || p.state.Captured != 48000 {
		t.Fatalf("Analysis or retained capture state is incorrect: %+v, %+v", p.analysis, p.state)
	}
	p.applyResponse(probeMessage{ID: 0, Data: json.RawMessage(`{"state":"idle","input_state":"idle","output_state":"idle"}`)})
	if p.analysis == nil {
		t.Fatal("Routine status erased a completed analysis")
	}
}

func TestAnalysisCommandUsesExistingProbeProtocol(t *testing.T) {
	data, err := json.Marshal(probeCommand{Version: 1, ID: 7, Op: "analyze", Frequency: 997})
	if err != nil || !strings.Contains(string(data), `"frequency_hz":997`) || strings.Contains(string(data), "device_id") {
		t.Fatalf("Invalid analysis command: %s, %v", data, err)
	}
}

func TestMatchDeviceRequiresUnambiguousIdentity(t *testing.T) {
	devices := []audioDevice{{ID: "id-a", Name: "Microphone"}, {ID: "id-b", Name: "Microphone"}}
	for _, tc := range []struct {
		requested string
		want      int
	}{{"id-a", 0}, {"id-b", 1}, {"Microphone", -1}, {"missing", -1}} {
		if got := matchDevice(devices, tc.requested); got != tc.want {
			t.Fatalf("matchDevice(%q) = %d, want %d", tc.requested, got, tc.want)
		}
	}
}
