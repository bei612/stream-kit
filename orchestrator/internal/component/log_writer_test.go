package component

import (
	"bytes"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestLogWriterDrainsLongLinesAndKeepsFollowingOutput(t *testing.T) {
	buffer := NewRingBuffer(10)
	w := &lineLogWriter{buffer: buffer, prefix: "err: "}
	for _, part := range [][]byte{[]byte("first\r"), []byte("\n\n"), bytes.Repeat([]byte("x"), maxComponentLogLine), []byte("overflow"), []byte("\nlast")} {
		if n, err := w.Write(part); n != len(part) || err != nil {
			t.Fatalf("write: %d %v", n, err)
		}
		if len(w.partial) > maxComponentLogLine {
			t.Fatal("unbounded line")
		}
	}
	w.flush()
	w.flush()
	want := []string{"err: first", "err: ", "err: " + strings.Repeat("x", maxComponentLogLine) + " [line truncated]", "err: last"}
	if got := buffer.GetLast(10); !reflect.DeepEqual(got, want) {
		t.Fatalf("line boundaries or truncation incorrect: lines=%d", len(got))
	}
}

func TestComponentOutputChild(t *testing.T) {
	if os.Getenv("STREAM_KIT_OUTPUT_TEST_CHILD") != "1" {
		return
	}
	_, _ = os.Stdout.Write(bytes.Repeat([]byte("x"), maxComponentLogLine*3))
	fmt.Fprint(os.Stdout, "\nstdout-final")
	fmt.Fprint(os.Stderr, "stderr-final")
	os.Exit(0)
}

func TestManagedProcessJoinsOutputBeforeDone(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	buffer := NewRingBuffer(10)
	process, err := StartProcess(executable, "-test.run=^TestComponentOutputChild$", "", map[string]string{"STREAM_KIT_OUTPUT_TEST_CHILD": "1"}, buffer, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	go process.RunWait()
	select {
	case <-process.Done:
	case <-time.After(15 * time.Second):
		_ = process.Cmd.Process.Kill()
		<-process.Done
		t.Fatal("oversized output blocked child exit")
	}
	if process.ExitCode != 0 {
		t.Fatalf("exit=%d", process.ExitCode)
	}
	lines := buffer.GetLast(10)
	contains := func(want string) bool {
		for _, line := range lines {
			if line == want {
				return true
			}
		}
		return false
	}
	if !contains("stdout-final") || !contains("[STDERR] stderr-final") {
		t.Fatal("Done closed before final logs were captured")
	}
	if len(lines) != 3 || !contains(strings.Repeat("x", maxComponentLogLine)+" [line truncated]") {
		t.Fatal("oversized line was not bounded")
	}
}
