//go:build windows

package audiodevice

import (
	"context"
	"fmt"
	"io"
	"os"
	"testing"
)

func TestPreparationPipeChild(t *testing.T) {
	mode := os.Getenv("STREAM_KIT_PREPARATION_CHILD")
	if mode == "" {
		return
	}
	switch mode {
	case "disabled":
		fmt.Println(`{"schema_version":1,"identity":null}`)
	case "invalid":
		fmt.Println(`{"schema_version":1,"identity":{"vendor_id":0,"product_id":0,"serial":""}}`)
	case "unknown":
		fmt.Println(`{"schema_version":1,"identity":null,"unexpected":true}`)
	case "version":
		fmt.Println(`{"schema_version":2,"identity":null}`)
	}
	data, _ := io.ReadAll(os.Stdin)
	if len(data) != 0 {
		os.Exit(3)
	} // Disabled/invalid identities must never attach.
	os.Exit(0)
}

func TestPreparationPipeDisabledAndInvalidNeverActivate(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"disabled", "invalid", "unknown", "version"} {
		t.Run(mode, func(t *testing.T) {
			err := PrepareWindowsGateway(context.Background(), executable, []string{"-test.run=^TestPreparationPipeChild$"}, t.TempDir(), map[string]string{"STREAM_KIT_PREPARATION_CHILD": mode})
			if (err == nil) != (mode == "disabled") {
				t.Fatalf("unexpected preparation result: %v", err)
			}
		})
	}
}
