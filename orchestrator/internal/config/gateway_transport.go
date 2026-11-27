package config

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// GatewayTransport scopes the existing managed deployment CA to the local
// gateway origin. External endpoints continue to use system trust.
type GatewayTransport struct {
	origin string
	native *http.Transport
}

func (c Config) ManagedGatewayTransport() (*GatewayTransport, error) {
	base, err := url.Parse(c.MoonlightWeb.BaseURL)
	if !c.Server.LANTLS.Enabled() || err != nil || base.Scheme != "https" {
		return nil, nil
	}
	host := base.Hostname()
	if !strings.EqualFold(host, "localhost") && !net.ParseIP(host).IsLoopback() {
		return nil, nil
	}
	raw, err := os.ReadFile(c.Server.LANTLS.CACert)
	if err != nil {
		return nil, fmt.Errorf("读取本机媒体网关 CA: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("本机媒体网关 CA 格式无效")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !ca.IsCA {
		return nil, fmt.Errorf("本机媒体网关 CA 证书无效")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	native := http.DefaultTransport.(*http.Transport).Clone()
	native.Proxy = nil
	native.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	return &GatewayTransport{origin: gatewayAuthority(base), native: native}, nil
}

func (t *GatewayTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme == "https" && gatewayAuthority(request.URL) == t.origin {
		return t.native.RoundTrip(request)
	}
	return http.DefaultTransport.RoundTrip(request)
}

func (t *GatewayTransport) CloseIdleConnections() {
	t.native.CloseIdleConnections()
}

func gatewayAuthority(address *url.URL) string {
	port := address.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(strings.ToLower(address.Hostname()), port)
}
