# Browser addresses and native HTTPS

This contract separates component-internal addresses from browser-visible addresses. Operational steps are in [LAN/TLS configuration](../docs/lan-address-configuration.md); released and installed revisions are tracked only in [release status](../docs/release-status.md).

## Address derivation

Native local component calls use loopback; do not replace them with a physical NIC's DHCP address. An empty `moonlight_web.public_url` derives the gateway origin from the hostname of the management request and the configured gateway port. An explicit public URL is an administrator override for reverse proxies or separately hosted gateways.

The gateway's `config.js` replaces loopback/unspecified control-plane hostnames with the hostname used to request the viewer, retaining scheme, control port and path. Explicit external hostnames remain unchanged. Request authority takes precedence, including HTTP/2 `:authority`; origin-form HTTP/1 falls back to Host. Forwarded host headers do not participate in this automatic mapping.

Management CORS supports `https://{host}:8080`, using the actual deployment scheme and gateway port. The placeholder matches only the management request hostname, with IPv6 brackets handled correctly; unrelated origins remain rejected. Literal origin entries are supported. Native installation selects the same-host template and leaves the public override empty.

HTTP/2 authority handling is implemented in the current source. Historical older-installer defects and acceptance bytes remain in [the HTTP/2 evidence](../docs/evidence/lan-http2-address-20261107.json); they must not be presented as a current requirement to use HTTP/1.

## Listeners and transport

Remote access needs reachable control and gateway listeners and the corresponding private-network firewall rules. Loopback-only is a supported local-only deployment. Listener changes require the owning component/service to restart.

HTTPS protects HTTP signaling and control traffic; WebRTC ICE/UDP remains a distinct media path. Explicit NAT mappings, reachable candidates and the configured UDP range must remain valid after a network change. Successful page loading is not proof of media or microphone delivery.

## HTTPS settings

| Setting | Required relationship |
| --- | --- |
| `server.tls_cert`, `server.tls_key` | Management certificate chain and matching private key |
| Gateway `web_server.certificate` | Gateway chain/key; same serving pair for managed same-host issuance |
| Gateway `web_server.control_plane_url` | Correct HTTPS control origin; loopback is valid internally when covered by the certificate |
| `server.cors_origins` | Actual HTTPS gateway origin or same-host template |
| `moonlight_web.public_url` | Empty for derived same-host links, otherwise explicit reachable HTTPS override |
| `moonlight_web.base_url` | Internal gateway HTTPS URL, system-trusted issuer and matching hostname |
| Gateway health-check URL | Correct HTTPS `/stream.html` URL with certificate verification enabled |

An initial HTTP-to-HTTPS change updates all callers of both listeners, not just the browser URL. The gateway client and media-state publisher use system trust. Trust installed only in a browser does not establish trust for the service identity.

`server.lan_tls` uses an existing deployment CA and explicit hosts. At service startup it renews/reissues the serving leaf before starting the local gateway, preserving the CA and existing leaf key. It does not silently create a replacement CA. Unchanged valid identity does not reissue unnecessarily. Read-only `check-config` does not create or update a leaf.

The current implementation does not automatically discover arbitrary new DHCP addresses and update the certificate. Add the actual new IP to configured hosts, review explicit URLs/origins/binds/ICE settings, preflight, and restart. Reusing the same CA avoids reinstalling client trust and rebuilding clients. Never disable TLS verification to hide an identity mismatch.

## Stable names and saved links

A numeric bookmark cannot rewrite its hostname after DHCP changes. Update only the origin of a permanent `/watch#key=…` link, preserving its capability. Android's server-address editor preserves that key as well.

A stable DNS/mDNS name can avoid numeric bookmark changes when it resolves correctly and appears in the certificate. Reuse Sunshine's Windows DnsServiceRegister or Linux Avahi publication instead of adding another discovery daemon. Linux packages include Avahi runtime and name-resolution dependencies.

Multicast isolation, VLANs, guest Wi-Fi and client resolver support still require verification; local resolution on the server is not proof of remote reachability. Name discovery does not establish trusted HTTPS identity.

## Validation

Check authority derivation under HTTP/1, HTTP/2 and IPv6; reject unrelated CORS origins. Verify both listeners with normal certificate checks, then actual admission, decoded media, control transfer and microphone routing. Preserve CA, application/watch identities and configured component ownership.

The [isolated Linux address-change evidence](../docs/evidence/lan-address-recovery-20261107.json) proves its recorded environment, not every Windows or Android migration. Shared-host NIC changes and reboot require the existing maintenance boundary. See current deployment status for the separately established local endpoint and media results.
