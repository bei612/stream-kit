package config

import (
	"net"
	"reflect"
	"testing"
)

func TestEligibleLANAddresses(t *testing.T) {
	for _, tc := range []struct {
		ip    string
		flags net.Flags
		want  bool
	}{
		{"192.168.0.119", net.FlagUp | net.FlagBroadcast, true},
		{"10.2.3.4", net.FlagUp, true},
		{"fd12::1", net.FlagUp, true},
		{"192.168.0.119", 0, false},
		{"10.0.0.1", net.FlagUp | net.FlagPointToPoint, false},
		{"127.0.0.1", net.FlagUp | net.FlagLoopback, false},
		{"169.254.1.1", net.FlagUp, false},
		{"fe80::1", net.FlagUp, false},
		{"0.0.0.0", net.FlagUp, false},
		{"224.0.0.1", net.FlagUp, false},
		{"8.8.8.8", net.FlagUp, false},
	} {
		if got := eligibleLANAddress(tc.flags, net.ParseIP(tc.ip)); got != tc.want {
			t.Errorf("%s flags %v got %v", tc.ip, tc.flags, got)
		}
	}
}

func TestAddressDiscoveryDoesNotPersistOrAccumulate(t *testing.T) {
	c := LANTLSConfig{Hosts: []string{"example.local"}, AutoDetect: true, AutoInterfaces: []string{"stream-kit-nonexistent-test-interface"}}
	before := append([]string(nil), c.Hosts...)
	hosts, err := managedCertificateHosts(c)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(hosts, []string{"127.0.0.1", "::1", "example.local", "localhost"}) {
		t.Fatal(hosts)
	}
	if !reflect.DeepEqual(c.Hosts, before) {
		t.Fatal("discovery mutated desired configuration")
	}
	// A machine without an eligible interface remains locally accessible;
	// discovering real interfaces later is independent from saved hosts.
	c.AutoDetect = false
	hosts, err = managedCertificateHosts(c)
	if err != nil || !reflect.DeepEqual(hosts, before) {
		t.Fatal(hosts, err)
	}
}

func TestDiscoveryDefaultsAndExplicitDisable(t *testing.T) {
	for _, tc := range []struct {
		json string
		want bool
	}{
		{`{"server":{}}`, true},
		{`{"server":{"lan_tls":{"auto_detect":false}}}`, false},
	} {
		cfg, err := decodeSettings([]byte(tc.json))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Server.LANTLS.AutoDetect != tc.want {
			t.Fatal("incorrect discovery default")
		}
		if cfg.Server.LANTLS.Enabled() {
			t.Fatal("discovery setting must not enable an unconfigured CA")
		}
	}
}
