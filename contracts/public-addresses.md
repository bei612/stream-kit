# Browser access when server addresses change

Native component-to-component addresses use loopback and do not follow the physical NIC address. Browser addresses are separate: an empty gateway `public_url` generates viewing links from the management page's actual hostname and the gateway port. An explicit external public URL remains an administrator override for reverse proxies and separately hosted gateways.

The gateway's `config.js` replaces a loopback/unspecified control-plane hostname with the hostname used to request the viewer. It retains the control port, scheme and path. An explicitly configured external control-plane hostname is preserved. Forwarded host headers are not used for this automatic mapping.

Management CORS can use `http://{host}:8080` (substitute the actual gateway scheme and port). The placeholder matches only the management request hostname, including IPv6 brackets. It does not allow unrelated hosts, schemes or ports. Existing literal origin entries remain supported. Native installation selects this same-host template and leaves the public gateway override empty.

For remote access, bind control and gateway listeners to an appropriate wildcard/interface, with corresponding private-network firewall rules. Loopback-only listeners remain available for local-only deployments. Listener changes require a component/service restart. Do not replace internal loopback API endpoints with the server's DHCP address.

A numeric URL already sent to a client cannot change its hostname when DHCP assigns another address. A stable hostname/domain with DNS updated to the current address provides the persistent entry point. Local machine-name resolution depends on the LAN's DNS/name services; public access requires a configured domain/DDNS and routing. Browser connections may briefly drop during a network change and reconnect through that stable name. Remote microphone access additionally requires browser-trusted HTTPS.

Verification must cover page assets from an external working directory, two different request IPs, a stable hostname, IPv6 authority formatting, and rejection of unrelated CORS origins. A deliberate DHCP/NIC change is not part of automated tests on a shared development host because it would interrupt unrelated projects and remote sessions.
