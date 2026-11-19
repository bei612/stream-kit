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

`server.lan_tls` uses an existing deployment CA. With `auto_detect` enabled (the default), startup and a single 15-second runtime refresh merge configured fixed hosts with eligible current private IPv4/IPv6 addresses. Discovery includes only active, non-loopback, non-point-to-point interfaces and excludes public, link-local and multicast addresses; `auto_interfaces` optionally restricts interface names. Automatic mode also retains localhost, 127.0.0.1 and ::1. With discovery disabled, the configured hosts are authoritative, including any required loopback identities.

The effective address set is an in-memory snapshot, not appended to persisted hosts; removed discovered addresses therefore do not accumulate. A valid unchanged identity is not reissued. Changes renew only the serving leaf while preserving the CA and existing leaf key. Management handshakes read the validated in-memory certificate; the gateway checks the shared identity files every 5 seconds and atomically adopts valid replacements for new connections. Reload failures retain the last valid identity and report failure/recovery transitions. Read-only `check-config` does not create or update a leaf.

Once this policy is configured and running, ordinary eligible LAN address changes do not require service restart, client recompilation or reinstalling client CA trust. The normal combined detection/reload interval is about 20 seconds, not an availability guarantee during network failure. Changing discovery policy, listeners or configured public URLs still requires the relevant configuration apply/restart. Review explicit URLs/origins/binds/ICE mappings and firewall rules separately: certificate discovery does not rewrite administrator overrides or make the old network route reachable. Never disable TLS verification to hide an identity mismatch.

## Stable names and saved links

A numeric bookmark cannot rewrite its hostname after DHCP changes. Update only the origin of a permanent `/watch#key=…` link, preserving its capability. Android's server-address editor preserves that key as well.

A stable DNS/mDNS name can avoid numeric bookmark changes when it resolves correctly and appears in the certificate. Reuse Sunshine's Windows DnsServiceRegister or Linux Avahi publication instead of adding another discovery daemon. Linux packages include Avahi runtime and name-resolution dependencies.

Multicast isolation, VLANs, guest Wi-Fi and client resolver support still require verification; local resolution on the server is not proof of remote reachability. Name discovery does not establish trusted HTTPS identity.

## Validation

Check authority derivation under HTTP/1, HTTP/2 and IPv6; reject unrelated CORS origins. Verify both listeners with normal certificate checks, then actual admission, decoded media, control transfer and microphone routing. Preserve CA, application/watch identities and configured component ownership.

The [automatic isolated Linux address-change evidence](../docs/evidence/lan-autodiscovery-515b9918-20261119.json) covers removal of the old address, trusted dual-listener identity updates and WebRTC recovery with unchanged CA, keys, configuration and process IDs. It proves its recorded source/environment, not Windows/Android primary-interface migration. Shared-host NIC changes and reboot require the existing maintenance boundary. See current deployment status for separately established local endpoint and media results.
