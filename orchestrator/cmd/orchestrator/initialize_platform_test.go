package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAdministratorInputDoesNotEchoCredentialsOnFailure(t *testing.T) {
	file := filepath.Join(t.TempDir(), "admin.json")
	for _, input := range []string{`{"name":123,"password":"sensitive-secret"}`, `{"name":"admin","password":"short"}`, strings.Repeat("sensitive-secret", 2000)} {
		if err := os.WriteFile(file, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		_, _, err := readAdministrator(file)
		if err == nil || strings.Contains(err.Error(), "sensitive-secret") {
			t.Fatal("invalid input accepted or echoed", err)
		}
	}
	if err := os.WriteFile(file, []byte(`{"name":"admin","password":"test-only-password"}`), 0600); err != nil {
		t.Fatal(err)
	}
	name, password, err := readAdministrator(file)
	if err != nil || name != "admin" || password != "test-only-password" {
		t.Fatal("valid administrator input rejected", err)
	}
}
