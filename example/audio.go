package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const audioMessage = 0x8001

// Explicit command-line playback is bounded and shares the normal device path.
var automaticToneDevice string
var automaticToneRemaining int
var automaticToneSeen bool

type audioDevice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Input  bool   `json:"input"`
	Output bool   `json:"output"`
}
type audioState struct {
	State       string  `json:"state"`
	InputState  string  `json:"input_state"`
	OutputState string  `json:"output_state"`
	Captured    uint64  `json:"captured_frames"`
	Played      uint64  `json:"played_frames"`
	Rate        uint64  `json:"sample_rate"`
	Peak        float64 `json:"peak"`
	RMS         float64 `json:"rms"`
	Dropped     uint64  `json:"dropped_frames"`
	Error       *string `json:"error"`
}
type probeMessage struct {
	Version int             `json:"schema_version"`
	ID      uint64          `json:"id"`
	Event   string          `json:"event"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}
type probeCommand struct {
	Version   int     `json:"schema_version"`
	ID        uint64  `json:"id"`
	Op        string  `json:"op"`
	DeviceID  string  `json:"device_id,omitempty"`
	Frequency float64 `json:"frequency_hz,omitempty"`
}
type audioAnalysis struct {
	Frequency float64 `json:"frequency_hz"`
	Rate      uint64  `json:"sample_rate"`
	Frames    uint64  `json:"analyzed_frames"`
	Peak      float64 `json:"peak_amplitude"`
	Mean      float64 `json:"mean_amplitude"`
}
type audioProbe struct {
	mu             sync.Mutex
	state          audioState
	devices        []audioDevice
	devicesChanged bool
	errorText      string
	analysis       *audioAnalysis
	lastCaptureID  uint64
	commands       chan probeCommand
	done           chan struct{}
	stdin          io.WriteCloser
	cmd            *exec.Cmd
	sequence       uint64
	hwnd           uintptr
}

func startAudio(hwnd uintptr) *audioProbe {
	p := &audioProbe{hwnd: hwnd, state: audioState{State: "idle", InputState: "idle", OutputState: "idle", Rate: 48000}, commands: make(chan probeCommand, 8), done: make(chan struct{})}
	path, err := os.Executable()
	if err != nil {
		p.errorText = err.Error()
		return p
	}
	p.cmd = exec.Command(filepath.Join(filepath.Dir(path), "audio-probe.exe"))
	p.cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	p.stdin, err = p.cmd.StdinPipe()
	if err != nil {
		p.errorText = err.Error()
		return p
	}
	out, err := p.cmd.StdoutPipe()
	if err != nil {
		p.stdin.Close()
		p.errorText = err.Error()
		return p
	}
	if err = p.cmd.Start(); err != nil {
		p.stdin.Close()
		out.Close()
		p.errorText = "Audio component unavailable: " + err.Error()
		return p
	}
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			var message probeMessage
			if json.Unmarshal(scanner.Bytes(), &message) != nil || message.Version != 1 {
				p.setError("Invalid audio component response")
				break
			}
			p.applyResponse(message)
			pPostMessage.Call(hwnd, audioMessage, 0, 0)
		}
		if err := scanner.Err(); err != nil {
			p.setError(err.Error())
		}
		if err := p.cmd.Wait(); err != nil {
			p.setError("Audio component exited: " + err.Error())
		}
		close(p.done)
	}()
	go func() {
		encoder := json.NewEncoder(p.stdin)
		for {
			select {
			case command, ok := <-p.commands:
				if !ok {
					return
				}
				if err := encoder.Encode(command); err != nil {
					p.setError(err.Error())
					return
				}
			case <-p.done:
				return
			}
		}
	}()
	p.send("devices", "")
	return p
}
func (p *audioProbe) applyResponse(message probeMessage) {
	p.mu.Lock()
	if message.Error != "" {
		p.errorText = message.Error
	} else {
		var analysis audioAnalysis
		var catalog struct {
			Devices []audioDevice `json:"devices"`
		}
		if json.Unmarshal(message.Data, &analysis) == nil && analysis.Frequency > 0 && analysis.Rate > 0 {
			if message.ID > p.lastCaptureID {
				p.analysis = &analysis
				p.errorText = ""
			}
		} else if json.Unmarshal(message.Data, &catalog) == nil && catalog.Devices != nil {
			p.devices = catalog.Devices
			p.devicesChanged = true
			p.errorText = ""
		} else {
			var state audioState
			if json.Unmarshal(message.Data, &state) == nil && state.State != "" {
				p.state = state
				p.errorText = ""
				if state.Error != nil {
					p.errorText = *state.Error
				}
			}
		}
	}
	p.mu.Unlock()
}
func (p *audioProbe) setError(message string) {
	p.mu.Lock()
	p.errorText = message
	p.mu.Unlock()
	pPostMessage.Call(p.hwnd, audioMessage, 0, 0)
}
func (p *audioProbe) send(op, id string) {
	p.sendCommand(probeCommand{Op: op, DeviceID: id})
}
func (p *audioProbe) analyze(frequency float64) {
	p.sendCommand(probeCommand{Op: "analyze", Frequency: frequency})
}
func (p *audioProbe) sendCommand(command probeCommand) {
	if p.cmd == nil || p.cmd.Process == nil {
		return
	}
	p.sequence++ // Only the UI thread sends commands.
	command.Version, command.ID = 1, p.sequence
	select {
	case <-p.done:
		p.setError("Audio component stopped; reopen the example")
	case p.commands <- command:
		if command.Op == "capture" {
			p.mu.Lock()
			p.analysis = nil
			p.lastCaptureID = command.ID
			p.mu.Unlock()
		}
	default:
		p.setError("Audio component busy; wait for the current operation")
	}
}
func (p *audioProbe) close() {
	if p.cmd == nil || p.cmd.Process == nil {
		return
	}
	close(p.commands)
	p.stdin.Close() // EOF is the audio lifetime boundary, including parent shutdown.
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		_ = p.cmd.Process.Kill() // Only this example's child, never other audio services.
		<-p.done
	}
}

var (
	pPostMessage                                                                = user32.NewProc("PostMessageW")
	pSendMessage                                                                = user32.NewProc("SendMessageW")
	pSetWindowText                                                              = user32.NewProc("SetWindowTextW")
	pMoveWindow                                                                 = user32.NewProc("MoveWindow")
	pInvalidateRect                                                             = user32.NewProc("InvalidateRect")
	pSetTimer                                                                   = user32.NewProc("SetTimer")
	pKillTimer                                                                  = user32.NewProc("KillTimer")
	probe                                                                       *audioProbe
	inputCombo, outputCombo, audioStatus, audioHeading, inputLabel, outputLabel uintptr
	audioButtons                                                                [len(audioButtonLabels)]uintptr
	audioAnalysisStatus                                                         uintptr
	inputDevices, outputDevices                                                 []audioDevice
	inputCount, pointerCount, frameCount                                        uint64
	audioBackground, audioFont                                                  uintptr
)

func control(parent uintptr, class, text string, style uintptr, id int) uintptr {
	// Keep UTF-16 storage alive through the syscall.
	c, _ := syscall.UTF16PtrFromString(class)
	t, _ := syscall.UTF16PtrFromString(text)
	h, _, _ := pCreateWindowEx.Call(0, uintptr(unsafe.Pointer(c)), uintptr(unsafe.Pointer(t)), 0x50000000|style, 0, 0, 0, 0, parent, uintptr(id), 0, 0)
	pSendMessage.Call(h, 0x0030, audioFont, 1)
	return h
}
func setupAudio(hwnd uintptr) {
	audioBackground, _, _ = pCreateSolidBrush.Call(rgb(15, 23, 42))
	fontName, _ := syscall.UTF16PtrFromString("Segoe UI")
	height := int32(-17)
	audioFont, _, _ = pCreateFontW.Call(uintptr(height), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 4, 0, uintptr(unsafe.Pointer(fontName)))
	audioHeading = control(hwnd, "STATIC", "AUDIO TEST  |  Explicit devices; no default audio changes", 0, 0)
	inputLabel = control(hwnd, "STATIC", "Microphone input (10-second maximum recording)", 0, 0)
	inputCombo = control(hwnd, "COMBOBOX", "", 0x00200000|0x00010000|3, 200)
	outputLabel = control(hwnd, "STATIC", "Program audio output (997 Hz test tone / recorded input)", 0, 0)
	outputCombo = control(hwnd, "COMBOBOX", "", 0x00200000|0x00010000|3, 201)
	for i, label := range audioButtonLabels {
		audioButtons[i] = control(hwnd, "BUTTON", label, 0x00010000|0x0000000b, 210+i)
	}
	audioStatus = control(hwnd, "STATIC", "Audio initialization...", 0, 220)
	audioAnalysisStatus = control(hwnd, "STATIC", "", 0, 221)
	probe = startAudio(hwnd)
	refreshAudio()
	layoutAudio(hwnd)
	pSetTimer.Call(hwnd, 1, 100, 0)
}
func layoutAudio(hwnd uintptr) {
	var rc RECT
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	w := int(rc.Right) - 48
	if w > 840 {
		w = 840
	}
	if w < 180 {
		w = 180
	}
	x := (int(rc.Right) - w) / 2
	y := int(rc.Bottom)/2 - 160
	if y < 90 {
		y = 90
	}
	move := func(h uintptr, top, height int) {
		pMoveWindow.Call(h, uintptr(x), uintptr(top), uintptr(w), uintptr(height), 1)
	}
	move(audioHeading, y, 24)
	move(inputLabel, y+34, 22)
	move(inputCombo, y+58, 200)
	move(outputLabel, y+96, 22)
	move(outputCombo, y+120, 200)
	buttonW := (w - 16) / 3
	for i, h := range audioButtons {
		pMoveWindow.Call(h, uintptr(x+(i%3)*(buttonW+8)), uintptr(y+164+(i/3)*38), uintptr(buttonW), 30, 1)
	}
	move(audioStatus, y+286, 76)
	move(audioAnalysisStatus, y+364, 54)
}
func selected(combo uintptr, devices []audioDevice) string {
	i, _, _ := pSendMessage.Call(combo, 0x0147, 0, 0)
	if int(i) < 0 || i >= uintptr(len(devices)) {
		return ""
	}
	return devices[i].ID
}
func fillDevices(combo uintptr, devices []audioDevice, selectedID string) {
	pSendMessage.Call(combo, 0x014B, 0, 0)
	for i, d := range devices {
		name, _ := syscall.UTF16PtrFromString(d.Name)
		pSendMessage.Call(combo, 0x0143, 0, uintptr(unsafe.Pointer(name)))
		if d.ID == selectedID {
			pSendMessage.Call(combo, 0x014E, uintptr(i), 0)
		}
	}
}

// Device names must be unique; stable IDs are preferred for automation.
func matchDevice(devices []audioDevice, requested string) int {
	match := -1
	for i, device := range devices {
		if device.ID == requested || device.Name == requested {
			if match >= 0 {
				return -1
			}
			match = i
		}
	}
	return match
}
func refreshAudio() {
	if probe == nil {
		return
	}
	probe.mu.Lock()
	state, errText := probe.state, probe.errorText
	analysis := probe.analysis
	changed := probe.devicesChanged
	devices := append([]audioDevice(nil), probe.devices...)
	probe.devicesChanged = false
	probe.mu.Unlock()
	if changed {
		oldInput, oldOutput := selected(inputCombo, inputDevices), selected(outputCombo, outputDevices)
		inputDevices = nil
		outputDevices = nil
		for _, d := range devices {
			if d.Input {
				inputDevices = append(inputDevices, d)
			}
			if d.Output {
				outputDevices = append(outputDevices, d)
			}
		}
		fillDevices(inputCombo, inputDevices, oldInput)
		fillDevices(outputCombo, outputDevices, oldOutput)
		if initialInputDevice != "" {
			requested := initialInputDevice
			initialInputDevice = ""
			if index := matchDevice(inputDevices, requested); index >= 0 {
				pSendMessage.Call(inputCombo, 0x014E, uintptr(index), 0)
			} else {
				probe.setError("Requested microphone input is missing or ambiguous; select an explicit device")
			}
		}
		if initialToneOutput != "" {
			requested := initialToneOutput
			initialToneOutput = ""
			index := matchDevice(outputDevices, requested)
			if index >= 0 {
				pSendMessage.Call(outputCombo, 0x014E, uintptr(index), 0)
				automaticToneDevice = outputDevices[index].ID
				automaticToneRemaining = initialToneCount - 1
				probe.send("tone", outputDevices[index].ID)
			} else {
				probe.setError("Requested tone output is missing or ambiguous; select an explicit device")
			}
		}
	}
	if automaticToneDevice != "" {
		if errText != "" || state.Error != nil {
			automaticToneDevice = ""
			automaticToneRemaining = 0
		} else if state.OutputState == "tone" {
			automaticToneSeen = true
		} else if state.OutputState == "completed" && automaticToneSeen {
			automaticToneSeen = false
			if automaticToneRemaining > 0 {
				automaticToneRemaining--
				probe.send("tone", automaticToneDevice)
			} else {
				automaticToneDevice = ""
			}
		}
	}
	text := fmt.Sprintf("Input: %s   |   Output: %s   |   Captured: %.2f s   |   Peak: %.3f   RMS: %.3f\r\nInput frames dropped: %d   |   Playback frames: %d\r\nRecording and test tone can run together. Input is held in memory only.", state.InputState, state.OutputState, float64(state.Captured)/48000, state.Peak, state.RMS, state.Dropped, state.Played)
	if errText != "" {
		text = "Audio error: " + errText
	}
	t, _ := syscall.UTF16PtrFromString(text)
	pSetWindowText.Call(audioStatus, uintptr(unsafe.Pointer(t)))
	analysisText := "Record and stop input, then analyze a test frequency. Measurements are not an acceptance result."
	if analysis != nil {
		analysisText = fmt.Sprintf("Recorded input: %.0f Hz | Mean: %.5f | Peak: %.5f | Analyzed: %.2f s\r\n1499 Hz: client test microphone. 997 Hz: program tone / possible return audio.", analysis.Frequency, analysis.Mean, analysis.Peak, float64(analysis.Frames)/float64(analysis.Rate))
	}
	a, _ := syscall.UTF16PtrFromString(analysisText)
	pSetWindowText.Call(audioAnalysisStatus, uintptr(unsafe.Pointer(a)))
}

type drawItem struct {
	ControlType, ID, ItemID, Action, State uint32
	Window, DC                             uintptr
	Rect                                   RECT
	Data                                   uintptr
}

func drawAudioButton(item *drawItem) {
	background := rgb(37, 50, 70)
	if item.ID == 211 || item.ID == 213 {
		background = rgb(36, 89, 165)
	}
	if item.State&1 != 0 {
		background = rgb(23, 42, 68)
	}
	brush, _, _ := pCreateSolidBrush.Call(background)
	pFillRect.Call(item.DC, uintptr(unsafe.Pointer(&item.Rect)), brush)
	pDeleteObject.Call(brush)
	pSetTextColor.Call(item.DC, rgb(232, 238, 248))
	pSetBkMode.Call(item.DC, TRANSPARENT)
	old, _, _ := pSelectObject.Call(item.DC, audioFont)
	if item.ID >= 210 && item.ID < 210+uint32(len(audioButtonLabels)) {
		t, _ := syscall.UTF16PtrFromString(audioButtonLabels[item.ID-210])
		pDrawTextW.Call(item.DC, uintptr(unsafe.Pointer(t)), ^uintptr(0), uintptr(unsafe.Pointer(&item.Rect)), DT_CENTER|DT_VCENTER|DT_SINGLELINE)
	}
	pSelectObject.Call(item.DC, old)
	if item.State&0x10 != 0 {
		user32.NewProc("DrawFocusRect").Call(item.DC, uintptr(unsafe.Pointer(&item.Rect)))
	}
}
func audioCommand(id uintptr) {
	automaticToneDevice = ""
	automaticToneRemaining = 0
	automaticToneSeen = false
	if probe == nil {
		return
	}
	switch id {
	case 210:
		probe.send("devices", "")
	case 211:
		probe.send("capture", selected(inputCombo, inputDevices))
	case 212:
		probe.send("stop", "")
	case 213:
		probe.send("tone", selected(outputCombo, outputDevices))
	case 214:
		probe.send("playback", selected(outputCombo, outputDevices))
	case 215:
		probe.send("stop_capture", "")
	case 216:
		probe.send("stop_playback", "")
	case 217:
		probe.analyze(1499)
	case 218:
		probe.analyze(997)
	}
}

var audioButtonLabels = [...]string{"Refresh devices", "Record input", "Stop all", "Play test tone", "Play recording", "Stop recording", "Stop playback", "Analyze client tone", "Analyze program tone"}
