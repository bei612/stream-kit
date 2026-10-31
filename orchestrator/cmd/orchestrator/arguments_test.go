package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestConfigArgument(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{nil, "config.json"},
		{[]string{"--config", `C:\Program Data\配置.json`}, `C:\Program Data\配置.json`},
		{[]string{"--config=/etc/stream-kit/config.json"}, "/etc/stream-kit/config.json"},
		{[]string{"--config=./-config.json"}, "./-config.json"},
		{[]string{"--config"}, ""},
		{[]string{"--config", ""}, ""},
		{[]string{"--config= "}, ""},
		{[]string{"--config", "--help"}, ""},
		{[]string{"--config", "one", "--config", "two"}, ""},
		{[]string{"--config=one", "extra"}, ""},
		{[]string{"--confg", "file"}, ""},
		{[]string{"start"}, ""},
		{[]string{"--config=bad\x00path"}, ""},
	} {
		got, err := configArgument(tc.args)
		if got != tc.want || (err != nil) != (tc.want == "") {
			t.Fatalf("args=%q got=%q err=%v", tc.args, got, err)
		}
	}
}

func TestCommandArgumentExit(t *testing.T) {
	if os.Getenv("STREAM_KIT_ARGUMENT_TEST_HELPER") == "1" {
		os.Args = append([]string{"orchestrator"}, os.Args[3:]...)
		main()
		os.Exit(0)
	}
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"--config"}, 2},
		{[]string{"--confg", "missing.json"}, 2},
		{[]string{"print-config", "--config"}, 2},
		{[]string{"version", "extra"}, 2},
		{[]string{"unknown-command"}, 2},
		{[]string{"verify-platform"}, 2},
		{[]string{"verify-platform", "missing-platform"}, 1},
		{[]string{"--help"}, 0},
		{[]string{"version"}, 0},
	} {
		dir := t.TempDir()
		args := append([]string{"-test.run=^TestCommandArgumentExit$", "--"}, tc.args...)
		cmd := exec.Command(os.Args[0], args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "STREAM_KIT_ARGUMENT_TEST_HELPER=1")
		output, err := cmd.CombinedOutput()
		if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != tc.code {
			t.Fatalf("args=%q err=%v output=%s", tc.args, err, output)
		}
		files, err := os.ReadDir(dir)
		if err != nil || len(files) != 0 {
			t.Fatalf("command created files: args=%q files=%v err=%v", tc.args, files, err)
		}
	}
}
