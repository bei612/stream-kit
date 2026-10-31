package mediacontrol

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestNodeClientsKeepSignedInventoriesAndCancellationIndependent(t *testing.T) {
	node := func(id, secret string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, err := io.ReadAll(r.Body)
			if err != nil || r.Method != http.MethodPost || r.URL.Path != "/node/internal/v2/audio-devices" ||
				r.Header.Get(controlSignatureHeader) != controlSignature([]byte(secret), audioRequestContext, body) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var request audioInventoryRequest
			if json.Unmarshal(body, &request) != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			response, err := json.Marshal(AudioInventory{
				InstanceID: "0123456789abcdef0123456789abcdef", SchemaVersion: 2, RequestID: request.RequestID, RequestIssuedAt: request.IssuedAt,
				ObservedAt: time.Now().UnixMilli(), Devices: []AudioDevice{{ID: id, Name: id, Output: true}},
				ConfiguredRoutes: []AudioRoute{},
			})
			if err != nil {
				t.Error(err)
				return
			}
			w.Header().Set(controlSignatureHeader, controlSignature([]byte(secret), audioResponseContext, response))
			_, _ = w.Write(response)
		}))
	}
	a, b := node("node-a-device", "key-a"), node("node-b-device", "key-b")
	defer a.Close()
	defer b.Close()
	clients := []*NodeClient{NewNodeClient(a.URL+"/node/", "key-a"), NewNodeClient(b.URL+"/node", "key-b")}
	for i, want := range []string{"node-a-device", "node-b-device"} {
		inventory, err := clients[i].AudioDevices(context.Background())
		if err != nil || len(inventory.Devices) != 1 || inventory.Devices[0].ID != want {
			t.Fatalf("node %d inventory: %+v, %v", i, inventory, err)
		}
	}
	if _, err := NewNodeClient(b.URL+"/node", "key-a").AudioDevices(context.Background()); err == nil {
		t.Fatal("one node's key authorized another node")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := clients[0].AudioDevices(ctx); err == nil {
		t.Fatal("cancelled node query succeeded")
	}
	if _, err := clients[1].AudioDevices(context.Background()); err != nil {
		t.Fatal("unrelated node query was cancelled", err)
	}
}

func TestNodeClientRejectsRedirectAndMissingConfiguration(t *testing.T) {
	if NewNodeClient("", "key") != nil || NewNodeClient("https://node.invalid", "") != nil {
		t.Fatal("unconfigured node was enabled")
	}
	var called atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called.Store(true) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	if _, err := NewNodeClient(origin.URL, "key").AudioDevices(context.Background()); err == nil || called.Load() {
		t.Fatal("node redirect was followed or accepted")
	}
}
