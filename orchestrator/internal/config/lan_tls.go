package config

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

func (c LANTLSConfig) Enabled() bool { return c.CACert != "" || c.CAKey != "" || len(c.Hosts) != 0 }

func validateLANTLS(c ServerConfig) error {
	if !c.LANTLS.Enabled() {
		return nil
	}
	if c.LANTLS.CACert == "" || c.LANTLS.CAKey == "" || c.TLSCert == "" || c.TLSKey == "" {
		return errors.New("局域网 TLS 需要配置现有 CA 证书/私钥及服务证书/私钥路径")
	}
	paths := []string{c.LANTLS.CACert, c.LANTLS.CAKey, c.TLSCert, c.TLSKey}
	for i, path := range paths {
		for _, other := range paths[:i] {
			if strings.EqualFold(filepath.Clean(path), filepath.Clean(other)) {
				return errors.New("CA 与服务证书、私钥必须使用四个不同文件")
			}
		}
	}
	_, _, err := certificateHosts(c.LANTLS.Hosts)
	return err
}

func certificateHosts(hosts []string) ([]string, []net.IP, error) {
	if len(hosts) == 0 || len(hosts) > 128 {
		return nil, nil, errors.New("局域网 TLS 地址需为 1–128 个 IP 或主机名")
	}
	dns, addresses, seen := []string{}, []net.IP{}, map[string]bool{}
	for _, raw := range hosts {
		host := strings.ToLower(strings.TrimSpace(raw))
		if ip := net.ParseIP(host); ip != nil {
			if ip.IsUnspecified() || ip.IsMulticast() {
				return nil, nil, errors.New("证书地址不能是通配监听地址或组播地址")
			}
			host = ip.String()
			if !seen[host] {
				addresses = append(addresses, ip)
				seen[host] = true
			}
			continue
		}
		if len(host) == 0 || len(host) > 253 {
			return nil, nil, errors.New("无效的 TLS 主机名")
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, nil, errors.New("无效的 TLS 主机名")
			}
			for _, r := range label {
				if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-') {
					return nil, nil, errors.New("TLS 地址应填写 IP 或 ASCII 主机名，不含协议、端口、通配符或路径")
				}
			}
		}
		if !seen[host] {
			dns = append(dns, host)
			seen[host] = true
		}
	}
	sort.Strings(dns)
	sort.Slice(addresses, func(i, j int) bool { return bytes.Compare(addresses[i].To16(), addresses[j].To16()) < 0 })
	return dns, addresses, nil
}

// PrepareManagedTLS reissues only the leaf, never replaces or creates a CA.
// Management and the local media gateway must reference the same leaf files.
// It runs before either listener/component starts, so a restart applies one identity.
func PrepareManagedTLS(c ServerConfig) error { return managedTLS(c, true, time.Now()) }

// CheckManagedTLS validates issuer, key and requested identities without writing files.
func CheckManagedTLS(c ServerConfig) error { return managedTLS(c, false, time.Now()) }

func managedTLS(c ServerConfig, persist bool, now time.Time) error {
	if !c.LANTLS.Enabled() {
		return nil
	}
	if err := validateLANTLS(c); err != nil {
		return err
	}
	dns, ips, _ := certificateHosts(c.LANTLS.Hosts)
	issuerPair, err := tls.LoadX509KeyPair(c.LANTLS.CACert, c.LANTLS.CAKey)
	if err != nil {
		return fmt.Errorf("读取原局域网 CA 失败（不会创建替代 CA）: %w", err)
	}
	issuer, err := x509.ParseCertificate(issuerPair.Certificate[0])
	if err != nil {
		return err
	}
	if !issuer.IsCA || !issuer.BasicConstraintsValid || issuer.KeyUsage&x509.KeyUsageCertSign == 0 || now.Before(issuer.NotBefore) || now.Add(24*time.Hour).After(issuer.NotAfter) {
		return errors.New("局域网 CA 无效或即将过期；不能通过静默更换信任根处理")
	}
	signer, ok := issuerPair.PrivateKey.(crypto.Signer)
	if !ok {
		return errors.New("不支持的 CA 私钥类型")
	}
	key, keyExists, err := leafKey(c.TLSKey)
	if err != nil {
		return err
	}
	if key == nil {
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return err
		}
	}
	if info, err := os.Lstat(c.TLSCert); err == nil && !info.Mode().IsRegular() {
		return errors.New("服务证书路径不是普通文件")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if existing, err := tls.LoadX509KeyPair(c.TLSCert, c.TLSKey); err == nil {
		leaf, err := x509.ParseCertificate(existing.Certificate[0])
		if err == nil && leaf.CheckSignatureFrom(issuer) != nil {
			return errors.New("现有服务证书不属于配置的 CA；拒绝因地址修改而更换信任根")
		}
		if err == nil && leaf.CheckSignatureFrom(issuer) == nil && !now.Before(leaf.NotBefore) && leaf.NotAfter.After(now.Add(30*24*time.Hour)) && !leaf.IsCA {
			oldDNS, oldIPs := append([]string{}, leaf.DNSNames...), append([]net.IP{}, leaf.IPAddresses...)
			sort.Strings(oldDNS)
			sort.Slice(oldIPs, func(i, j int) bool { return bytes.Compare(oldIPs[i].To16(), oldIPs[j].To16()) < 0 })
			matches := reflect.DeepEqual(oldDNS, dns) && len(oldIPs) == len(ips)
			for i := range oldIPs {
				if i >= len(ips) || !oldIPs[i].Equal(ips[i]) {
					matches = false
					break
				}
			}
			serverAuth := false
			for _, use := range leaf.ExtKeyUsage {
				if use == x509.ExtKeyUsageServerAuth {
					serverAuth = true
				}
			}
			if matches && serverAuth {
				return nil
			}
		}
	}
	if !persist {
		return nil
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	expires := now.Add(365 * 24 * time.Hour)
	if issuer.NotAfter.Before(expires) {
		expires = issuer.NotAfter
	}
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Stream Kit LAN"}, NotBefore: now.Add(-5 * time.Minute), NotAfter: expires,
		DNSNames: dns, IPAddresses: ips, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, issuer, key.Public(), signer)
	if err != nil {
		return err
	}
	if !keyExists {
		encoded, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return err
		}
		// Exclusivity prevents concurrent startup from replacing an existing private key.
		file, err := os.OpenFile(c.TLSKey, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}))
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	chain := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	for _, cert := range issuerPair.Certificate {
		chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})...)
	}
	// Atomic replacement retains the leaf key and original CA even on write failure.
	return writeSettings(c.TLSCert, chain)
}

func leafKey(path string) (crypto.Signer, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, true, errors.New("服务私钥路径不是普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, true, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, true, errors.New("无法解析现有服务私钥，不会覆盖")
	}
	var key any
	switch block.Type {
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(block.Bytes)
	default:
		err = errors.New("不支持的服务私钥格式")
	}
	if err != nil {
		return nil, true, err
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, true, errors.New("不支持的服务私钥类型")
	}
	return signer, true, nil
}
