package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func lanFixture(t *testing.T) (ServerConfig, *x509.CertPool) {
	t.Helper()
	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test deployment CA"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(2 * 365 * 24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cfg := ServerConfig{TLSCert: filepath.Join(dir, "server.crt"), TLSKey: filepath.Join(dir, "server.key"), LANTLS: LANTLSConfig{CACert: filepath.Join(dir, "ca.crt"), CAKey: filepath.Join(dir, "ca.key"), Hosts: []string{"127.0.0.1", "192.168.3.66", "volcengine.local"}}}
	root := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(cfg.LANTLS.CACert, root, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.LANTLS.CAKey, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0600); err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(root)
	return cfg, pool
}

func fileDigest(t *testing.T, path string) [32]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(data)
}

func leafCertificate(t *testing.T, cfg ServerConfig) *x509.Certificate {
	t.Helper()
	pair, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func TestLANAddressChangeRetainsClientTrustAndPrivateKeys(t *testing.T) {
	cfg, roots := lanFixture(t)
	caCert, caKey := fileDigest(t, cfg.LANTLS.CACert), fileDigest(t, cfg.LANTLS.CAKey)
	if err := CheckManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{cfg.TLSCert, cfg.TLSKey} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("preflight wrote TLS outputs", path, err)
		}
	}
	if err := PrepareManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	old := leafCertificate(t, cfg)
	leafKeyHash := fileDigest(t, cfg.TLSKey)
	if _, err := old.Verify(x509.VerifyOptions{Roots: roots, DNSName: "192.168.3.66"}); err != nil {
		t.Fatal(err)
	}
	cfg.LANTLS.Hosts = []string{"127.0.0.1", "192.168.8.88", "volcengine.local"}
	if err := PrepareManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	current := leafCertificate(t, cfg)
	if _, err := current.Verify(x509.VerifyOptions{Roots: roots, DNSName: "192.168.8.88"}); err != nil {
		t.Fatal("original client CA must trust new address", err)
	}
	if current.VerifyHostname("192.168.3.66") == nil {
		t.Fatal("removed address remains certified")
	}
	if fileDigest(t, cfg.LANTLS.CACert) != caCert || fileDigest(t, cfg.LANTLS.CAKey) != caKey || fileDigest(t, cfg.TLSKey) != leafKeyHash {
		t.Fatal("address update replaced trust or key identity")
	}
	first := fileDigest(t, cfg.TLSCert)
	if err := PrepareManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	if fileDigest(t, cfg.TLSCert) != first {
		t.Fatal("unchanged healthy leaf was needlessly reissued")
	}
	// A new listener presents the renewed certificate to an unchanged client trust pool.
	pair, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	defer server.Close()
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "192.168.8.88", MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal(response.StatusCode)
	}
}

func TestLANInvalidIssuerOrKeyNeverChangesTrust(t *testing.T) {
	cfg, _ := lanFixture(t)
	if err := PrepareManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	before := fileDigest(t, cfg.TLSCert)
	cfg.LANTLS.Hosts = []string{"192.168.8.88"}
	if err := os.WriteFile(cfg.LANTLS.CAKey, []byte("invalid key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := PrepareManagedTLS(cfg); err == nil {
		t.Fatal("invalid CA key accepted")
	}
	if fileDigest(t, cfg.TLSCert) != before {
		t.Fatal("failed issuance changed current leaf")
	}
	if string(mustRead(t, cfg.LANTLS.CAKey)) != "invalid key" {
		t.Fatal("issuer key replaced")
	}
}

func TestLANAddressUpdateCannotSilentlySwitchIssuer(t *testing.T) {
	cfg, _ := lanFixture(t)
	if err := PrepareManagedTLS(cfg); err != nil {
		t.Fatal(err)
	}
	before := fileDigest(t, cfg.TLSCert)
	other, _ := lanFixture(t)
	cfg.LANTLS.CACert, cfg.LANTLS.CAKey = other.LANTLS.CACert, other.LANTLS.CAKey
	if err := CheckManagedTLS(cfg); err == nil {
		t.Fatal("issuer replacement accepted by preflight")
	}
	if err := PrepareManagedTLS(cfg); err == nil {
		t.Fatal("issuer replacement accepted by startup")
	}
	if fileDigest(t, cfg.TLSCert) != before {
		t.Fatal("rejected issuer changed current leaf")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	v, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	return v
}

func TestLANRejectsAmbiguousHostsAndOverlappingIdentityFiles(t *testing.T) {
	for _, hosts := range [][]string{nil, {"0.0.0.0"}, {"::"}, {"https://192.168.3.66"}, {"host:9000"}, {"*.example.com"}, {"a..b"}, {"224.0.0.1"}, {"fe80::1%4"}} {
		if _, _, err := certificateHosts(hosts); err == nil {
			t.Fatalf("invalid identity accepted: %v", hosts)
		}
	}
	cfg, _ := lanFixture(t)
	cfg.TLSCert = cfg.LANTLS.CACert
	if err := PrepareManagedTLS(cfg); err == nil {
		t.Fatal("issuer output overlap allowed")
	}
}

func TestLANRenewalPreservesIssuerAndIsReadOnlyDuringCheck(t *testing.T) {
	cfg, _ := lanFixture(t)
	now := time.Now()
	if err := managedTLS(cfg, true, now); err != nil {
		t.Fatal(err)
	}
	first := fileDigest(t, cfg.TLSCert)
	root := fileDigest(t, cfg.LANTLS.CACert)
	if err := managedTLS(cfg, false, now.Add(340*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if fileDigest(t, cfg.TLSCert) != first {
		t.Fatal("renewal preflight wrote files")
	}
	if err := managedTLS(cfg, true, now.Add(340*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if fileDigest(t, cfg.TLSCert) == first || fileDigest(t, cfg.LANTLS.CACert) != root {
		t.Fatal("renewal failed or changed root")
	}
}
