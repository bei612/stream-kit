//go:build windows

package component

import (
	"errors"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestRenderSessionRequiresKnownNonzeroSession(t *testing.T) {
	for _, id := range []uint32{1, 2, 100} {
		if err := validateRenderSession(id, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateRenderSession(0, nil); err == nil {
		t.Fatal("Session 0 accepted for direct rendering")
	}
	queryError := errors.New("session lookup failed")
	if err := validateRenderSession(1, queryError); !errors.Is(err, queryError) {
		t.Fatal("lookup failure ignored")
	}
}

func TestHeadlessAndExternallyManagedComponentsDoNotRequireDesktop(t *testing.T) {
	for _, name := range []string{"moonlight-web", "worker"} {
		if err := checkLaunchContext(name, config.ComponentConfig{ExePath: "headless.exe"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkLaunchContext("sunshine", config.ComponentConfig{}); err != nil {
		t.Fatal(err)
	}
}
