package main

import "testing"

func TestServiceCommandRejectsAmbiguousArguments(t *testing.T) {
	for _, args := range [][]string{
		nil, {"install"}, {"install", "config.json"},
		{"replace", "--config", "config.json"},
		{"install", "--config", ""},
		{"install", "--config", "config.json", "--force"},
	} {
		if err := serviceCommand(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}
