package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Explicitly enabled development observer; never a global keyboard hook.
// Counts are emitted only after this window's own message loop receives input.
var inputEventsEnabled bool

type inputEvent struct {
	SchemaVersion    int    `json:"schema_version"`
	Type             string `json:"type"`
	Event            string `json:"event"`
	ProcessID        int    `json:"process_id"`
	Time             string `json:"time"`
	Keys             uint64 `json:"keys"`
	Clicks           uint64 `json:"clicks"`
	Foreground       bool   `json:"foreground"`
	HasKeyboardFocus bool   `json:"has_keyboard_focus"`
}

func emitInputEvent(event string, window uintptr) {
	if !inputEventsEnabled {
		return
	}
	foreground, _, _ := user32.NewProc("GetForegroundWindow").Call()
	focus, _, _ := user32.NewProc("GetFocus").Call()
	child, _, _ := user32.NewProc("IsChild").Call(window, focus)
	data, err := json.Marshal(inputEvent{
		SchemaVersion: 1, Type: "stream-kit-example-input", Event: event,
		ProcessID: os.Getpid(), Time: time.Now().UTC().Format(time.RFC3339Nano),
		Keys: inputCount, Clicks: pointerCount, Foreground: foreground == window,
		HasKeyboardFocus: focus == window || child != 0,
	})
	if err == nil {
		// No text, key codes, audio, credentials, or other applications' events.
		fmt.Fprintln(os.Stdout, string(data))
	}
}
