package mediacontrol

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayConfigurationSignedBoundary(t *testing.T) {
	secret := []byte("configuration-test-secret")
	for _, mode := range []string{"read", "save", "unsigned", "wrong-domain", "wrong-nonce", "conflict", "invalid", "status-mismatch", "running-mismatch", "running-invalid", "running-known", "runtime-valid", "runtime-zero-pid", "runtime-invalid", "runtime-missing-instance"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				if r.URL.Path != "/internal/v1/configuration" || r.Header.Get(controlSignatureHeader) != controlSignature(secret, configurationRequestContext, raw) {
					t.Error("invalid outgoing signature or path")
				}
				var request map[string]any
				if err := json.Unmarshal(raw, &request); err != nil {
					t.Error(err)
					return
				}
				operation := "read"
				if mode == "save" {
					operation = "save"
				}
				if request["operation"] != operation {
					t.Error("wrong operation")
				}
				result := map[string]any{"status": "ok", "data": GatewayConfiguration{Revision: strings.Repeat("a", 64), ApplyPolicy: "gateway_restart", Values: map[string]json.RawMessage{"webrtc": json.RawMessage(`{}`)}, RedactedPaths: []string{}, OverriddenPaths: []string{}}}
				if strings.HasPrefix(mode, "running-") {
					view := result["data"].(GatewayConfiguration)
					running := view.Revision
					if mode == "running-mismatch" {
						running = strings.Repeat("b", 64)
					}
					if mode == "running-invalid" {
						running = strings.Repeat("z", 64)
					}
					view.RunningRevision = &running
					result["data"] = view
				}
				status := 200
				if strings.HasPrefix(mode, "runtime-") {
					view := result["data"].(GatewayConfiguration)
					view.Runtime = &GatewayRuntimeIdentity{ProcessID: 1234, InstanceID: strings.Repeat("c", 32)}
					switch mode {
					case "runtime-zero-pid":
						view.Runtime.ProcessID = 0
					case "runtime-invalid":
						view.Runtime.InstanceID = strings.Repeat("z", 32)
					case "runtime-missing-instance":
						view.Runtime.InstanceID = ""
					}
					result["data"] = view
				}
				if mode == "conflict" || mode == "status-mismatch" {
					status = 409
					result = map[string]any{"status": "error", "code": "CONFIGURATION_CONFLICT", "message": "private remote diagnostic"}
				}
				if mode == "invalid" {
					status = 400
					result = map[string]any{"status": "error", "code": "CONFIGURATION_INVALID"}
				}
				if mode == "status-mismatch" {
					status = 200
				}
				nonce := request["request_id"]
				if mode == "wrong-nonce" {
					nonce = "other"
				}
				body, _ := json.Marshal(map[string]any{"schema_version": 1, "request_id": nonce, "request_issued_at_ms": request["issued_at_ms"], "result": result})
				domain := configurationResponseContext
				if mode == "wrong-domain" {
					domain = audioResponseContext
				}
				if mode != "unsigned" {
					w.Header().Set(controlSignatureHeader, controlSignature(secret, domain, body))
				}
				w.WriteHeader(status)
				_, _ = w.Write(body)
			}))
			defer server.Close()
			p := NodeClient{baseURL: server.URL, secret: secret, client: server.Client()}
			var changes map[string]json.RawMessage
			revision := ""
			if mode == "save" {
				revision = strings.Repeat("a", 64)
				changes = map[string]json.RawMessage{"/moonlight/pair_device_name": json.RawMessage(`"test"`)}
			}
			view, err := p.GatewayConfiguration(context.Background(), revision, changes)
			switch mode {
			case "read", "save", "running-known", "runtime-valid":
				if err != nil || view == nil {
					t.Fatal(err)
				}
				if mode == "runtime-valid" && (view.Runtime == nil || view.Runtime.ProcessID != 1234 || view.Runtime.InstanceID != strings.Repeat("c", 32)) {
					t.Fatal("runtime identity was not preserved")
				}
			case "conflict":
				if !errors.Is(err, ErrConfigurationConflict) {
					t.Fatal(err)
				}
			case "invalid":
				if !errors.Is(err, ErrConfigurationInvalid) {
					t.Fatal(err)
				}
			default:
				if !errors.Is(err, ErrConfigurationUnavailable) {
					t.Fatal("untrusted reply accepted", err)
				}
			}
			if err != nil && strings.Contains(err.Error(), "private remote") {
				t.Fatal("remote diagnostic leaked")
			}
		})
	}
}
