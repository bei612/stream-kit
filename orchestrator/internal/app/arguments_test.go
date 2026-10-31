package app

import (
	"errors"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestLaunchArgumentsRejectInvalidTemplatesAcrossEntryPoints(t *testing.T) {
	for _, tc := range []struct {
		name, args, template, contents string
	}{
		{"unknown", "", "missing", ""},
		{"template newline", "", "bad", "one\ntwo"},
		{"template NUL", "", "bad", "one\x00two"},
		{"template oversized", "", "bad", strings.Repeat("x", 4097)},
		{"literal oversized", strings.Repeat("x", 4097), "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager, st, req := localFixture(t)
			manager.config.Templates["bad"] = tc.contents
			record, err := manager.RegisterLocal(req)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := manager.CreateApp("archive", tc.template, tc.args, "game.exe", 1, model.CaptureDesktop); !errors.Is(err, ErrInvalidLaunchArguments) {
				t.Fatal("archive accepted invalid arguments", err)
			}
			req.Name, req.Args, req.ArgsTemplate = "local", tc.args, tc.template
			if _, err := manager.RegisterLocal(req); !errors.Is(err, ErrInvalidLocalApp) {
				t.Fatal("local registration accepted invalid arguments", err)
			}
			if err := manager.UpdateApp(record.ID, nil, &tc.args, &tc.template, nil); !errors.Is(err, ErrInvalidLaunchArguments) {
				t.Fatal("edit accepted invalid arguments", err)
			}
			after, err := st.GetApp(record.ID)
			if err != nil || after.Args != record.Args || after.ArgsTemplate != nil {
				t.Fatal("rejected edit changed persisted arguments", err)
			}
			for _, name := range []string{"archive", "local"} {
				if found, err := st.GetAppByName(name); err != nil || found != nil {
					t.Fatal("rejected registration persisted", name, err)
				}
			}
		})
	}
}

func TestLaunchTemplateResolutionAndClearing(t *testing.T) {
	manager, st, req := localFixture(t)
	manager.config.Templates["boundary"] = strings.Repeat("x", 4096)
	if args, err := manager.resolveArguments("ignored", "boundary"); err != nil || len(args) != 4096 {
		t.Fatal("valid boundary template rejected", err)
	}
	req.ArgsTemplate = "windowed"
	record, err := manager.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	empty, replacement := "", "--quality high"
	if err := manager.UpdateApp(record.ID, nil, &replacement, &empty, nil); err != nil {
		t.Fatal(err)
	}
	after, err := st.GetApp(record.ID)
	if err != nil || after.Args != replacement || (after.ArgsTemplate != nil && *after.ArgsTemplate != "") {
		t.Fatal("clearing template did not preserve explicit arguments", err)
	}
}
