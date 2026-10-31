package component

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestArgumentGrammarPreservesValues(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  []string
	}{
		{``, nil},
		{`"" ''`, []string{"", ""}},
		{`--path "C:\Program Files\Renderer\"`, []string{"--path", `C:\Program Files\Renderer\`}},
		{`--name=pre"two words"post`, []string{"--name=pretwo wordspost"}},
		{"one\ttwo\nthree\u3000four", []string{"one", "two", "three", "four"}},
		{`'say "hello"' "it's fine"`, []string{`say "hello"`, "it's fine"}},
		{`$HOME $(program) *.txt`, []string{"$HOME", "$(program)", "*.txt"}},
	} {
		got, err := commandline.Parse(tc.input)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("input=%q got=%q err=%v", tc.input, got, err)
		}
	}
	for _, input := range []string{`"private-value`, `'private-value`, "private\x00value"} {
		if _, err := commandline.Parse(input); err == nil || strings.Contains(err.Error(), "private") {
			t.Fatalf("invalid arguments accepted or echoed: %v", err)
		}
	}
}

func TestManagedArgumentsHelper(t *testing.T) {
	if os.Getenv("STREAM_KIT_ARGUMENT_HELPER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			_ = json.NewEncoder(os.Stdout).Encode(os.Args[i+1:])
			os.Exit(0)
		}
	}
	os.Exit(2)
}

func TestManagedChildReceivesEmptyAndQuotedArguments(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	logs := NewRingBuffer(10)
	mp, err := StartProcess(exe, `-test.run=^TestManagedArgumentsHelper$ -- "" "C:\Program Files\Renderer\" 'say "hello"'`, t.TempDir(), map[string]string{"STREAM_KIT_ARGUMENT_HELPER": "1"}, logs, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	go mp.RunWait()
	select {
	case <-mp.Done:
	case <-time.After(10 * time.Second):
		_ = forceStop(mp)
		t.Fatal("child did not exit")
	}
	if mp.ExitCode != 0 {
		t.Fatalf("exit=%d", mp.ExitCode)
	}
	lines := logs.GetLast(10)
	if len(lines) != 1 {
		t.Fatalf("output=%v", lines)
	}
	var got []string
	if err := json.Unmarshal([]byte(lines[0]), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"", `C:\Program Files\Renderer\`, `say "hello"`}) {
		t.Fatalf("child argv=%q", got)
	}
}

func TestMalformedArgumentsRejectBeforeRestartStopsOwnedProcess(t *testing.T) {
	m, old := runningOwnedComponent(t)
	cfg := m.configs["test"]
	cfg.Args = `"unfinished`
	m.configs["test"] = cfg
	if err := m.Restart("test"); err == nil {
		t.Fatal("restart accepted malformed arguments")
	}
	if ownedProcess(m.components["test"]) != old {
		t.Fatal("invalid arguments stopped the owned process")
	}
	select {
	case <-old.Done:
		t.Fatal("owned child exited")
	default:
	}
	if err := preflight(context.Background(), config.ComponentConfig{PreflightArgs: `"unfinished`}); err == nil {
		t.Fatal("malformed preflight accepted")
	}
}
