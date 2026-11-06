package moonlight

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestManagedEnrollmentFirstLaunchAndConcurrentReuse(t *testing.T) {
	var mu sync.Mutex
	created, paired, logins := 0, 0, 0
	state := "Free"
	host := rendererHost{Host: Host{HostID: 7, Paired: "NotPaired"}, Address: "127.0.0.1", HTTPPort: 47989, UniqueID: "renderer-identity", ServerState: &state}
	approved := make(chan struct{})
	digest := strings.Repeat("ab", 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/api/login" && r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("missing admin session")
		}
		switch r.URL.Path {
		case "/api/login":
			logins++
			http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
		case "/api/hosts":
			hosts := []Host{}
			if created > 0 {
				hosts = append(hosts, host.Host)
			}
			json.NewEncoder(w).Encode(map[string]any{"hosts": hosts})
		case "/api/host":
			if r.Method == "POST" {
				var body struct {
					Address string `json:"address"`
					Port    uint16 `json:"http_port"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				if body.Address != host.Address || body.Port != host.HTTPPort {
					t.Error("wrong renderer target")
				}
				created++
			}
			json.NewEncoder(w).Encode(map[string]any{"host": host})
		case "/api/host/pair/managed":
			paired++
			json.NewEncoder(w).Encode(map[string]any{"schema_version": 1, "pin": "0123", "client_certificate_sha256": digest})
			w.(http.Flusher).Flush()
			select {
			case <-approved:
			case <-r.Context().Done():
				return
			}
			host.Paired = "Paired"
			json.NewEncoder(w).Encode(map[string]any{"Paired": host})
		case "/api/apps":
			if r.URL.Query().Get("host_id") != "7" || host.Paired != "Paired" {
				t.Error("app lookup before exact pairing")
			}
			json.NewEncoder(w).Encode(map[string]any{"apps": []App{{AppID: 771}}})
		default:
			t.Error(r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client := NewClient(config.MoonlightWebConfig{BaseURL: server.URL}, zap.NewNop())
	approve := func(_ context.Context, certificate, pin string) error {
		if certificate != digest || pin != "0123" {
			return fmt.Errorf("incorrect challenge")
		}
		close(approved)
		return nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info, err := client.FindManagedStream(context.Background(), "127.0.0.1", 47989, 771, approve)
			if err != nil || info == nil || info.HostID != 7 {
				t.Errorf("launch: %+v %v", info, err)
			}
		}()
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if created != 1 || paired != 1 || logins != 1 {
		t.Fatalf("duplicate enrollment: %d %d %d", created, paired, logins)
	}
}

func TestManagedEnrollmentFailsClosed(t *testing.T) {
	for _, scenario := range []string{"wrong_endpoint", "offline", "duplicate", "bad_challenge", "changed_identity", "denied", "read_only"} {
		t.Run(scenario, func(t *testing.T) {
			state := "Free"
			host := rendererHost{Host: Host{HostID: 7, Paired: "NotPaired"}, Address: "renderer", HTTPPort: 47989, UniqueID: "identity", ServerState: &state}
			approvals, mutations := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/login":
					http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
				case "/api/hosts":
					hosts := []Host{host.Host}
					if scenario == "duplicate" {
						hosts = append(hosts, Host{HostID: 8})
					}
					json.NewEncoder(w).Encode(map[string]any{"hosts": hosts})
				case "/api/host":
					copy := host
					if r.Method == "POST" {
						mutations++
						copy.Address = "different-renderer"
					}
					if scenario == "wrong_endpoint" {
						copy.Address = "different-renderer"
					}
					if scenario == "offline" {
						copy.ServerState = nil
					}
					if r.URL.Query().Get("host_id") == "8" {
						copy.HostID = 8
					}
					json.NewEncoder(w).Encode(map[string]any{"host": copy})
				case "/api/host/pair/managed":
					mutations++
					digest := strings.Repeat("ab", 32)
					if scenario == "bad_challenge" {
						digest = "bad"
					}
					json.NewEncoder(w).Encode(map[string]any{"schema_version": 1, "pin": "0123", "client_certificate_sha256": digest})
					copy := host
					copy.Paired = "Paired"
					copy.UniqueID = "changed"
					json.NewEncoder(w).Encode(map[string]any{"Paired": copy})
				case "/api/apps":
					t.Error("failed enrollment reached catalog")
					w.WriteHeader(500)
				default:
					t.Error(r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			client := NewClient(config.MoonlightWebConfig{BaseURL: server.URL}, zap.NewNop())
			approve := func(context.Context, string, string) error {
				approvals++
				if scenario == "denied" {
					return fmt.Errorf("denied")
				}
				return nil
			}
			var err error
			if scenario == "read_only" {
				_, err = client.FindRendererStream(context.Background(), "renderer", 47989, 771)
			} else {
				_, err = client.FindManagedStream(context.Background(), "renderer", 47989, 771, approve)
			}
			if err == nil {
				t.Fatal("unsafe enrollment accepted")
			}
			if scenario != "changed_identity" && scenario != "denied" && approvals != 0 {
				t.Fatal("approved invalid challenge")
			}
			if scenario == "read_only" && mutations != 0 {
				t.Fatal("read-only lookup mutated pairing")
			}
		})
	}
}

func TestEnrollmentWaitHonorsCancellation(t *testing.T) {
	client := NewClient(config.MoonlightWebConfig{}, zap.NewNop())
	client.enrollment <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := client.FindRendererStream(ctx, "renderer", 47989, 771); err == nil {
		t.Fatal("blocked lookup ignored context")
	}
}
