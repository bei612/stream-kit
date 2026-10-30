package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestInstalledSPAWithExternalConfiguration(t *testing.T) {
	root := t.TempDir()
	base, install := filepath.Join(root, "configuration"), filepath.Join(root, "installation")
	assets := filepath.Join(install, "dist")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("installed management page"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "app.js"), []byte("installed javascript"), 0600); err != nil {
		t.Fatal(err)
	}
	// A build-output directory is not a frontend bundle.
	if err := os.MkdirAll(filepath.Join(base, "dist"), 0700); err != nil {
		t.Fatal(err)
	}
	selected := spaDirectory(base, filepath.Join(install, "orchestrator"))
	if selected != assets {
		t.Fatalf("selected %q, want %q", selected, assets)
	}
	r := gin.New()
	r.Use(spaMiddleware(selected))
	for path, want := range map[string]string{"/": "installed management page", "/settings": "installed management page", "/app.js": "installed javascript"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Body.String() != want {
			t.Fatalf("%s: %d %q", path, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/missing", nil))
	if w.Code != 404 {
		t.Fatalf("API route became a management page: %d", w.Code)
	}
	// Existing configuration-local deployments retain precedence.
	local := filepath.Join(base, "dist")
	if err := os.WriteFile(filepath.Join(local, "index.html"), []byte("override"), 0600); err != nil {
		t.Fatal(err)
	}
	if spaDirectory(base, filepath.Join(install, "orchestrator")) != local {
		t.Fatal("configuration-local override lost precedence")
	}
}

func TestSPADirectoryRequiresRegularIndex(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "dist", "index.html"), 0700); err != nil {
		t.Fatal(err)
	}
	if spaDirectory(base, "") != "" {
		t.Fatal("directory accepted as index")
	}
	dev := filepath.Join(base, "web", "dist")
	if err := os.MkdirAll(dev, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dev, "index.html"), []byte("development"), 0600); err != nil {
		t.Fatal(err)
	}
	if spaDirectory(base, "") != dev {
		t.Fatal("development bundle not selected")
	}
}
