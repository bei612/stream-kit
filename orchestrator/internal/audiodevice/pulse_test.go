package audiodevice

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

type fakePulse struct {
	modules        []module
	endpoints      map[string][]endpoint
	loads, unloads int
	failSource     bool
}

func (f *fakePulse) run(_ context.Context, args ...string) ([]byte, error) {
	switch args[0] {
	case "--format=json":
		if args[2] == "modules" {
			return json.Marshal(f.modules)
		}
		return json.Marshal(f.endpoints[args[2]])
	case "load-module":
		if f.failSource && args[1] == "module-remap-source" {
			return nil, fmt.Errorf("source load failed")
		}
		f.loads++
		id := uint32(100 + f.loads)
		f.modules = append(f.modules, module{id, args[1], strings.Join(args[2:], " ")})
		for _, s := range specs {
			if s.driver == args[1] {
				f.endpoints[s.kind] = append(f.endpoints[s.kind], endpoint{s.name, &id})
			}
		}
		return []byte(strconv.Itoa(int(id))), nil
	case "unload-module":
		f.unloads++
		id, _ := strconv.Atoi(args[1])
		for i, m := range f.modules {
			if m.Index == uint32(id) {
				f.modules = append(f.modules[:i], f.modules[i+1:]...)
				break
			}
		}
		return nil, nil
	}
	return nil, fmt.Errorf("unexpected command %v", args)
}
func TestProvisionReuseAndCollision(t *testing.T) {
	f := &fakePulse{endpoints: map[string][]endpoint{}}
	pair, err := EnsurePulse(context.Background(), f.run)
	if err != nil {
		t.Fatal(err)
	}
	if pair.Render != "pulseaudio:stream_kit_microphone" || pair.Capture != "pulseaudio:stream_kit_microphone_capture" {
		t.Fatal(pair)
	}
	if _, err = EnsurePulse(context.Background(), f.run); err != nil || f.loads != 2 {
		t.Fatalf("reuse: %v, loads %d", err, f.loads)
	}
	f.modules[1].Argument = "master=unrelated"
	if _, err = EnsurePulse(context.Background(), f.run); err == nil || f.loads != 2 || f.unloads != 0 {
		t.Fatal("foreign endpoint must be rejected without mutation")
	}
}
func TestPartialFailureRemovesOnlyNewModules(t *testing.T) {
	f := &fakePulse{endpoints: map[string][]endpoint{}, failSource: true, modules: []module{{9, "module-null-sink", "sink_name=unrelated"}}}
	if _, err := EnsurePulse(context.Background(), f.run); err == nil {
		t.Fatal("expected source failure")
	}
	if f.unloads != 1 || len(f.modules) != 1 || f.modules[0].Index != 9 {
		t.Fatalf("incorrect cleanup: %+v", f)
	}
}
func TestPulseIntegration(t *testing.T) {
	if os.Getenv("STREAM_KIT_ISOLATED_AUDIO_TEST") != "1" {
		t.Skip("requires the isolated Linux audio fixture")
	}
	ctx := context.Background()
	pair, err := EnsurePulse(ctx, Pactl)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EnsurePulse(ctx, Pactl)
	if err != nil || pair != again {
		t.Fatalf("reuse failed: %+v %v", again, err)
	}
	for _, s := range specs {
		id, err := find(ctx, Pactl, s)
		if err != nil || id == nil {
			t.Fatalf("missing endpoint: %s %v", s.name, err)
		}
	}
	t.Logf("real provisioned endpoints: %+v", pair)
}
