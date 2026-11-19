package config

import (
	"fmt"
	"net"
	"sort"
)

// Only directly assigned private LAN addresses on live non-point-to-point
// interfaces are discovered. Public/NAT identities remain administrator-owned.
// An optional interface allowlist disambiguates LANs from virtual adapters;
// absence of a listed adapter during boot is valid and retried by the owner.
func eligibleLANAddress(flags net.Flags, ip net.IP) bool {
	return flags&net.FlagUp != 0 && flags&(net.FlagLoopback|net.FlagPointToPoint) == 0 &&
		ip.IsPrivate() && ip.IsGlobalUnicast()
}

func managedCertificateHosts(c LANTLSConfig) ([]string, error) {
	hosts := append([]string(nil), c.Hosts...)
	if !c.AutoDetect {
		return hosts, nil
	}
	hosts = append(hosts, "localhost", "127.0.0.1", "::1")
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("enumerate LAN interfaces: %w", err)
	}
	allowed := make(map[string]bool, len(c.AutoInterfaces))
	for _, name := range c.AutoInterfaces {
		allowed[name] = true
	}
	for _, iface := range interfaces {
		if len(allowed) > 0 && !allowed[iface.Name] {
			continue
		}
		if iface.Flags&net.FlagUp == 0 || iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			// The adapter can disappear between the two OS calls. Re-read the
			// inventory to distinguish removal from a genuine enumeration error.
			current, inventoryErr := net.Interfaces()
			if inventoryErr != nil {
				return nil, fmt.Errorf("refresh LAN interfaces: %w", inventoryErr)
			}
			present := false
			for _, candidate := range current {
				if candidate.Index == iface.Index && candidate.Name == iface.Name {
					present = true
					break
				}
			}
			if !present {
				continue
			}
			return nil, fmt.Errorf("enumerate LAN interface %q: %w", iface.Name, err)
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && eligibleLANAddress(iface.Flags, ip) {
				hosts = append(hosts, ip.String())
			}
		}
	}
	// Snapshot only: never append discovered addresses to the persisted hosts
	// list. Removed DHCP/IPv6 addresses therefore cannot accumulate over time.
	unique := make(map[string]bool, len(hosts))
	for _, host := range hosts {
		unique[host] = true
	}
	hosts = make([]string, 0, len(unique))
	for host := range unique {
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	return hosts, nil
}
