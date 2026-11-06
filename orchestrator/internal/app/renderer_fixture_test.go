package app

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
)

func writeRendererFixture(w http.ResponseWriter, r *http.Request, portOffset int) {
	address, portText, _ := net.SplitHostPort(r.Host)
	port, _ := strconv.Atoi(portText)
	id, _ := strconv.Atoi(r.URL.Query().Get("host_id"))
	json.NewEncoder(w).Encode(map[string]any{"host": map[string]any{
		"host_id": id, "address": address, "http_port": port + portOffset,
		"paired": "Paired", "unique_id": "fixture-renderer", "server_state": "Free",
	}})
}
