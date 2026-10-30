package ws

import (
	"net/http"
	"strings"
)

const Subprotocol = "stream-kit.events.v1"
const CredentialPrefix = "stream-kit.auth."

// UpgradeCredential carries the existing management bearer in an HTTP header,
// because the browser WebSocket API cannot set Authorization. Only Subprotocol
// is negotiated back to the client; the credential must never be echoed/logged.
func UpgradeCredential(r *http.Request) string {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return ""
	}
	var token string
	version := false
	count := 0
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, value := range strings.Split(header, ",") {
			value = strings.TrimSpace(value)
			if value == Subprotocol {
				version = true
			}
			if strings.HasPrefix(value, CredentialPrefix) {
				count++
				token = strings.TrimPrefix(value, CredentialPrefix)
			}
		}
	}
	if !version || count != 1 || len(token) > 8192 {
		return ""
	}
	return token
}
