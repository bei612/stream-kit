# Browser access when server addresses change

Native component-to-component addresses use loopback and do not follow the physical NIC address. Browser addresses are separate: an empty gateway `public_url` generates viewing links from the management page's actual hostname and the gateway port. An explicit external public URL remains an administrator override for reverse proxies and separately hosted gateways.

The gateway's `config.js` replaces a loopback/unspecified control-plane hostname with the hostname used to request the viewer. It retains the control port, scheme and path. An explicitly configured external control-plane hostname is preserved. Forwarded host headers are not used for this automatic mapping.

Management CORS can use `http://{host}:8080` (substitute the actual gateway scheme and port). The placeholder matches only the management request hostname, including IPv6 brackets. It does not allow unrelated hosts, schemes or ports. Existing literal origin entries remain supported. Native installation selects this same-host template and leaves the public gateway override empty.

For remote access, bind control and gateway listeners to an appropriate wildcard/interface, with corresponding private-network firewall rules. Loopback-only listeners remain available for local-only deployments. Listener changes require a component/service restart. Do not replace internal loopback API endpoints with the server's DHCP address.

A numeric URL already sent to a client cannot change its hostname when DHCP assigns another address. A stable hostname/domain with DNS updated to the current address provides the persistent entry point. Local machine-name resolution depends on the LAN's DNS/name services; public access requires a configured domain/DDNS and routing. Browser connections may briefly drop during a network change and reconnect through that stable name. Remote microphone access additionally requires browser-trusted HTTPS.

Verification must cover page assets from an external working directory, two different request IPs, a stable hostname, IPv6 authority formatting, and rejection of unrelated CORS origins. A deliberate DHCP/NIC change is not part of automated tests on a shared development host because it would interrupt unrelated projects and remote sessions.

## Native HTTPS deployment

The existing native listeners support TLS without another server process. A deployment must choose its stable browser hostname and certificate trust model before changing the running HTTP installation. A managed domain can use a publicly trusted certificate; a private LAN hostname requires a private certificate authority trusted by each client. Certificate issuance, name resolution and browser trust are separate deployment requirements. A generated self-signed certificate alone is not evidence of a working browser microphone.

Apply the following settings as one service maintenance operation, preserving the existing configuration for rollback. Paths refer to protected deployment files, not repository fixtures. Certificate private keys must be readable only by the service/worker identities that actually serve TLS and the administrator.

| Configuration | Required HTTPS value |
| --- | --- |
| Orchestrator `server.tls_cert`, `server.tls_key` | Matching PEM certificate chain and private key for the management hostname |
| Gateway `web_server.certificate.certificate_pem`, `private_key_pem` | Matching PEM chain and key for the gateway hostname |
| Gateway `web_server.control_plane_url` | `https://<stable-management-host>:9000`; the browser configuration preserves this scheme |
| Orchestrator `server.cors_origins` | `https://{host}:8080` for the same-host layout, or the exact separately hosted gateway origin |
| Orchestrator `moonlight_web.public_url` | Empty for same-host links; an explicit HTTPS URL for a separately hosted gateway |
| Orchestrator `moonlight_web.base_url` | An HTTPS gateway URL whose hostname matches the certificate and whose chain the service trusts |
| Orchestrator `components.web_server.health_check.url` | The certificate-valid HTTPS gateway URL ending in `/stream.html`; keep certificate verification enabled |

The default internal HTTP loopback addresses are appropriate while those listeners serve HTTP. Once a native listener switches to HTTPS, every caller of that listener must switch with it. With private certificates, a loopback internal URL is valid only if that IP is covered by the certificate and the calling service trusts its issuer. Otherwise use a stable certificate-covered hostname resolving to this server. Do not disable certificate verification to compensate for a hostname or trust mismatch. The Orchestrator gateway client and media-state publisher use system trust; the health checker also verifies certificates by default. Browser trust alone therefore does not establish internal service trust.

Run the existing native configuration preflights before restarting. After restart, check all component health, browser login and viewing invitation redemption, actual video/audio transport, control transfer, and browser microphone permission through the HTTPS hostname without certificate-error overrides. ICE/UDP remains the media transport and retains its configured LAN firewall scope; HTTPS does not replace those UDP rules. A successful TLS file/key preflight proves parsing and key correspondence, not browser trust or a completed voice acceptance.

The installed LAN HTTP and example result is recorded in `docs/evidence/local-lan-demo-20261104.json`. That receipt explicitly does not claim HTTPS, a physical remote client, human speech, or a real DHCP change.
