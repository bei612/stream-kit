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

func TestModuleTableRetainsEmptyArguments(t *testing.T) {
	run := func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "--format=json" {
			return []byte(`[{"name":"module-native-protocol-unix","argument":""}]`), nil
		}
		return []byte("7\tmodule-native-protocol-unix\t\t\r\n"), nil
	}
	modules, err := listModules(context.Background(), run)
	if err != nil || len(modules) != 1 || modules[0].Index != 7 || modules[0].Argument != "" {
		t.Fatalf("valid empty module argument rejected: %+v %v", modules, err)
	}
}

func TestModuleTableMultilineAndChangedSnapshot(t *testing.T) {
	f := &fakePulse{modules: []module{{7, "native", "{\n\tkey = value\n12\tinside-argument\tdata\t\n}"}, {8, "empty", ""}}}
	modules, err := listModules(context.Background(), f.run)
	if err != nil || len(modules) != 2 || modules[0].Argument != f.modules[0].Argument || modules[1].Index != 8 {
		t.Fatalf("multiline module changed: %+v %v", modules, err)
	}
	changed := func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "list" {
			f.modules[1].Name = "replaced"
		}
		return f.run(ctx, args...)
	}
	if _, err = listModules(context.Background(), changed); err == nil {
		t.Fatal("changed inventory accepted")
	}
}

func (f *fakePulse) run(_ context.Context, args ...string) ([]byte, error) {
	switch args[0] {
	case "list":
		var lines []string
		for _, m := range f.modules {
			lines = append(lines, fmt.Sprintf("%d\t%s\t%s\t", m.Index, m.Name, m.Argument))
		}
		if len(lines) == 0 {
			return nil, nil
		}
		return []byte(strings.Join(lines, "\n") + "\n"), nil
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
		for kind, entries := range f.endpoints {
			kept := []endpoint{}
			for _, e := range entries {
				if e.Owner == nil || *e.Owner != uint32(id) {
					kept = append(kept, e)
				}
			}
			f.endpoints[kind] = kept
		}
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
	beforeSink, err := Pactl(ctx, "get-default-sink")
	if err != nil {
		t.Fatal(err)
	}
	beforeSource, err := Pactl(ctx, "get-default-source")
	if err != nil {
		t.Fatal(err)
	}
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
	afterSink, err := Pactl(ctx, "get-default-sink")
	if err != nil {
		t.Fatal(err)
	}
	afterSource, err := Pactl(ctx, "get-default-source")
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeSink) != string(afterSink) || string(beforeSource) != string(afterSource) {
		t.Fatal("default audio endpoints changed")
	}
	if err = ReleasePulse(ctx, Pactl); err != nil {
		t.Fatal(err)
	}
	for _, s := range specs {
		id, err := find(ctx, Pactl, s)
		if err != nil || id != nil {
			t.Fatalf("release failed for %s: %v", s.name, err)
		}
	}
}

func TestReleasePreservesForeignEndpoints(t *testing.T) {
	f := &fakePulse{endpoints: map[string][]endpoint{}}
	if _, err := EnsurePulse(context.Background(), f.run); err != nil {
		t.Fatal(err)
	}
	f.modules[1].Argument = "master=other"
	if err := ReleasePulse(context.Background(), f.run); err == nil || f.unloads != 0 {
		t.Fatal("foreign source must prevent any removal")
	}
	f.modules[1].Argument = strings.Join(specs[1].args, " ")
	if err := ReleasePulse(context.Background(), f.run); err != nil || f.unloads != 2 {
		t.Fatal("owned endpoints not released", err)
	}
	if err := ReleasePulse(context.Background(), f.run); err != nil || f.unloads != 2 {
		t.Fatal("release must be idempotent", err)
	}
}
