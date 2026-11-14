package server

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

func TestControlBudgetPreservesConfiguredArchiveUpload(t *testing.T) {
	base := t.TempDir()
	st, err := store.New(filepath.Join(base, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cfg := &config.Config{Server: config.ServerConfig{JWTSecret: "isolated-upload-budget"}, Storage: config.StorageConfig{AppsDir: filepath.Join(base, "apps"), TempDir: filepath.Join(base, "temp"), MaxUploadSize: 4 << 20, MaxExtractSize: 4 << 20, MaxFileCount: 10}}
	manager := app.NewManager(st, cfg, nil, nil, nil, zap.NewNop())
	defer manager.Shutdown(context.Background())
	server := httptest.NewServer(New(cfg, st, nil, manager, nil, nil, zap.NewNop()).Engine)
	defer server.Close()
	var archive, body bytes.Buffer
	payload := bytes.Repeat([]byte("a"), 2<<20)
	tarWriter := tar.NewWriter(&archive)
	if err = tarWriter.WriteHeader(&tar.Header{Name: "payload.bin", Mode: 0644, Size: int64(len(payload))}); err != nil {
		t.Fatal(err)
	}
	if _, err = tarWriter.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err = tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	form := multipart.NewWriter(&body)
	form.WriteField("name", "large-native-upload")
	file, err := form.CreateFormFile("file", "application.tar")
	if err != nil {
		t.Fatal(err)
	}
	file.Write(archive.Bytes())
	form.Close()
	now := time.Now()
	token := identity.Sign(identity.Management, handlers.Claims{Sub: "admin", Iat: now.Unix(), Exp: now.Add(time.Minute).Unix()}, handlers.ResolveJWTSecret(cfg.Server.JWTSecret, ""))
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/apps/upload", &body)
	req.ContentLength = -1
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Data struct {
			ID string `json:"app_id"`
		} `json:"data"`
	}
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil || response.StatusCode != 200 {
		t.Fatalf("upload failed: HTTP %d, %v", response.StatusCode, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for manager.IsUploading() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if manager.IsUploading() {
		t.Fatal("upload did not settle")
	}
	record, err := st.GetApp(result.Data.ID)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filepath.Join(record.AppDir, "payload.bin"))
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatalf("archive payload not preserved: %v", err)
	}
}

// Exercise the production router, real capability verification and session
// manager over native HTTP, including chunked requests without Content-Length.
func TestClientHeartbeatBodyBudget(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{JWTSecret: "isolated-budget-test"}}
	manager := session.NewManager(nil)
	s, err := manager.EnsureAdmission(1, 2, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := manager.AddClientConnection(s.ID, "budget-viewer", "web")
	if err != nil {
		t.Fatal(err)
	}
	secret := handlers.ResolveJWTSecret(cfg.Server.JWTSecret, "")
	now := time.Now()
	token := identity.Sign(identity.Connection, identity.Claims{Subject: connection.UserID, SessionID: s.ID, ConnectionID: connection.ID, IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix()}, identity.DeriveKey(secret, identity.Connection))
	server := httptest.NewServer(New(cfg, nil, nil, nil, nil, manager, zap.NewNop()).Engine)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	path := server.URL + "/api/v1/client-sessions/" + s.ID + "/connections/" + connection.ID + "/heartbeat"
	for _, chunked := range []bool{false, true} {
		t.Run(map[bool]string{false: "content-length", true: "chunked"}[chunked], func(t *testing.T) {
			before, _ := manager.Get(s.ID)
			payload := `{"microphone":false,"padding":"` + strings.Repeat("x", 4<<20) + `"}`
			req, _ := http.NewRequest(http.MethodPost, path, strings.NewReader(payload))
			if chunked {
				req.ContentLength = -1
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 400 && response.StatusCode != 413 {
				t.Fatalf("oversized heartbeat accepted: HTTP %d", response.StatusCode)
			}
			after, _ := manager.Get(s.ID)
			if after.Revision != before.Revision {
				t.Fatal("rejected body mutated session")
			}
		})
	}
	req, _ := http.NewRequest(http.MethodPost, path, strings.NewReader(`{"microphone":false,"microphone_live":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Status string `json:"status"`
	}
	if err = json.NewDecoder(response.Body).Decode(&body); err != nil || response.StatusCode != 200 || body.Status != "ok" {
		t.Fatalf("normal heartbeat failed: HTTP %d, %v", response.StatusCode, err)
	}
}
