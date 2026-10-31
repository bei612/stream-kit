package mediacontrol

import (
	"net/http"
	"strings"
	"time"
)

// NodeClient owns the authenticated management connection to one configured
// media node. Device inventory, explicit pair verification and configuration do
// not require a session manager or hold the state publisher's renewal lock.
// The address and secret must come from trusted deployment configuration,
// never from browser-supplied audio device identifiers or media tickets.
type NodeClient struct {
	baseURL string
	secret  []byte
	client  *http.Client
}

func NewNodeClient(baseURL, secret string) *NodeClient {
	if baseURL == "" || secret == "" {
		return nil
	}
	return &NodeClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  []byte(secret),
		client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}
