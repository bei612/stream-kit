package store

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestWatchLinkPersistenceRotationAndRemoval(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.db")
	st, err := New(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.CreateApp(makeApp("a", "A")); err != nil {
		t.Fatal(err)
	}
	first, err := st.PublishWatchLink("a", false)
	if err != nil || len(first) != 43 {
		t.Fatalf("publish: %v", err)
	}
	same, err := st.PublishWatchLink("a", false)
	if err != nil || same != first {
		t.Fatal("publish rotated a stable link")
	}
	app, err := st.AppForWatchToken(first)
	if err != nil || app.ID != "a" {
		t.Fatal("wrong app")
	}
	data, _ := json.Marshal(app)
	if strings.Contains(string(data), first) {
		t.Fatal("app JSON leaked link authority")
	}
	if err = st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = New(file)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err = st.AppForWatchToken(first); err != nil {
		t.Fatal("link lost across restart", err)
	}
	next, err := st.PublishWatchLink("a", true)
	if err != nil || next == first {
		t.Fatal("rotation failed", err)
	}
	if _, err = st.AppForWatchToken(first); err == nil {
		t.Fatal("old link still valid")
	}
	if _, err = st.AppForWatchToken(next); err != nil {
		t.Fatal(err)
	}
	if err = st.DisableWatchLink("a"); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppForWatchToken(next); err == nil {
		t.Fatal("disabled link still valid")
	}
	final, err := st.PublishWatchLink("a", false)
	if err != nil || final == next {
		t.Fatal("re-enable reused revoked link")
	}
	if err = st.DeleteApp("a"); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppForWatchToken(final); err == nil {
		t.Fatal("deleted app remains published")
	}
	if _, err = st.PublishWatchLink("missing", false); err == nil {
		t.Fatal("published missing app")
	}
}
