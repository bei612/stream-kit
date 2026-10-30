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
	for _, mode := range []string{"read", "save", "unsigned", "wrong-domain", "wrong-nonce", "conflict", "invalid", "status-mismatch"} {
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
				status := 200
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
			p := Publisher{baseURL: server.URL, secret: secret, client: server.Client()}
			var changes map[string]json.RawMessage
			revision := ""
			if mode == "save" {
				revision = strings.Repeat("a", 64)
				changes = map[string]json.RawMessage{"/moonlight/pair_device_name": json.RawMessage(`"test"`)}
			}
			view, err := p.GatewayConfiguration(context.Background(), revision, changes)
			switch mode {
			case "read", "save":
				if err != nil || view == nil {
					t.Fatal(err)
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
