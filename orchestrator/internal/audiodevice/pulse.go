// Package audiodevice provisions platform-owned recording endpoints. It does
// not change session routing: the existing device catalog and audio-target API
// remain the sole configuration path for choosing a recording target.
package audiodevice

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type Runner func(context.Context, ...string) ([]byte, error)
type Pair struct {
	Render  string `json:"render_device_id"`
	Capture string `json:"capture_device_id"`
}
type module struct {
	Index    uint32 `json:"index"`
	Name     string `json:"name"`
	Argument string `json:"argument"`
}
type endpoint struct {
	Name  string  `json:"name"`
	Owner *uint32 `json:"owner_module"`
}
type spec struct {
	kind, name, driver string
	args               []string
}

var specs = []spec{
	{"sinks", "stream_kit_microphone", "module-null-sink", []string{"sink_name=stream_kit_microphone", "rate=48000", "channels=2", "sink_properties=device.description=StreamKit-Microphone-Input"}},
	{"sources", "stream_kit_microphone_capture", "module-remap-source", []string{"master=stream_kit_microphone.monitor", "source_name=stream_kit_microphone_capture", "rate=48000", "channels=2", "source_properties=device.description=StreamKit-Microphone"}},
}

// Pactl uses the current user's authenticated audio connection, never an
// anonymous daemon or a shell command. The installed package owns this path.
func Pactl(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "/usr/bin/pactl", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("audio server command %s failed: %w", args[0], err)
	}
	if len(out) > 4*1024*1024 {
		return nil, fmt.Errorf("audio server inventory exceeds size limit")
	}
	return out, nil
}
func list[T any](ctx context.Context, run Runner, kind string) ([]T, error) {
	data, err := run(ctx, "--format=json", "list", kind)
	if err != nil {
		return nil, err
	}
	var entries []T
	if err = json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("invalid audio %s inventory: %w", kind, err)
	}
	return entries, nil
}
func arguments(value string) map[string]string {
	result := map[string]string{}
	for _, arg := range strings.Fields(value) {
		k, v, ok := strings.Cut(arg, "=")
		if !ok {
			return nil
		}
		if _, exists := result[k]; exists {
			return nil
		}
		result[k] = v
	}
	return result
}
func matches(m module, s spec) bool {
	return m.Name == s.driver && reflect.DeepEqual(arguments(m.Argument), arguments(strings.Join(s.args, " ")))
}
func find(ctx context.Context, run Runner, s spec) (*uint32, error) {
	devices, err := list[endpoint](ctx, run, s.kind)
	if err != nil {
		return nil, err
	}
	modules, err := listModules(ctx, run)
	if err != nil {
		return nil, err
	}
	for _, device := range devices {
		if device.Name == s.name {
			for _, m := range modules {
				if device.Owner != nil && m.Index == *device.Owner && matches(m, s) {
					id := m.Index
					return &id, nil
				}
			}
			return nil, fmt.Errorf("audio endpoint %s already exists with a different owner or configuration", s.name)
		}
	}
	return nil, nil
}

// EnsurePulse creates one dedicated pair, or reuses the exact managed modules.
// On partial failure it removes only modules created by this invocation, after
// rechecking their identity; stale module indexes alone never authorize unload.
func EnsurePulse(ctx context.Context, run Runner) (pair Pair, err error) {
	created := []module{}
	defer func() {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for i := len(created) - 1; i >= 0; i-- {
				current, e := listModules(cleanup, run)
				if e != nil {
					err = fmt.Errorf("%w; cleanup inventory failed: %v", err, e)
					continue
				}
				for _, m := range current {
					if reflect.DeepEqual(m, created[i]) {
						if _, e = run(cleanup, "unload-module", strconv.FormatUint(uint64(m.Index), 10)); e != nil {
							err = fmt.Errorf("%w; cleanup failed: %v", err, e)
						}
					}
				}
			}
		}
	}()
	// Check both names before creating anything, including a source collision.
	for _, s := range specs {
		if _, err = find(ctx, run, s); err != nil {
			return pair, err
		}
	}
	for _, s := range specs {
		var id *uint32
		if id, err = find(ctx, run, s); err != nil {
			return pair, err
		}
		if id != nil {
			continue
		}
		var data []byte
		data, err = run(ctx, append([]string{"load-module", s.driver}, s.args...)...)
		if err != nil {
			return pair, err
		}
		var index uint64
		index, err = strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
		if err != nil {
			return pair, fmt.Errorf("invalid loaded module identifier: %w", err)
		}
		created = append(created, module{uint32(index), s.driver, strings.Join(s.args, " ")})
		id, err = find(ctx, run, s)
		if err != nil {
			return pair, err
		}
		if id == nil || *id != uint32(index) {
			return pair, fmt.Errorf("created audio endpoint %s failed identity verification", s.name)
		}
	}
	return Pair{"pulseaudio:" + specs[0].name, "pulseaudio:" + specs[1].name}, nil
}

// ReleasePulse follows service lifetime. Validate both names first, then remove
// the recording source before its backing sink, never a foreign configuration.
func ReleasePulse(ctx context.Context, run Runner) error {
	for _, s := range specs {
		if _, err := find(ctx, run, s); err != nil {
			return err
		}
	}
	for i := len(specs) - 1; i >= 0; i-- {
		id, err := find(ctx, run, specs[i])
		if err != nil {
			return err
		}
		if id == nil {
			continue
		}
		if _, err = run(ctx, "unload-module", strconv.FormatUint(uint64(*id), 10)); err != nil {
			return err
		}
	}
	return nil
}

// pactl's JSON module objects omit the index. The documented short table
// includes the numeric owner ID and tab-delimits arguments independently.
func listModules(ctx context.Context, run Runner) ([]module, error) {
	data, err := run(ctx, "list", "short", "modules")
	if err != nil {
		return nil, err
	}
	result := []module{}
	seen := map[uint32]bool{}
	for _, line := range strings.Split(strings.TrimRight(string(data), "\r\n"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			return nil, fmt.Errorf("invalid module table")
		}
		id, err := strconv.ParseUint(fields[0], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("invalid module ID: %w", err)
		}
		if seen[uint32(id)] {
			return nil, fmt.Errorf("duplicate module ID")
		}
		seen[uint32(id)] = true
		result = append(result, module{uint32(id), fields[1], fields[2]})
	}
	return result, nil
}
