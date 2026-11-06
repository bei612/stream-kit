# Android managed client integration

Status: implementation in progress, not an APK delivery claim. Scope: [current goal](../docs/goal-current.md).

## One managed session and transport

The Android fork lives in `third_party/moonlight-android`, pinned to official v12.2 with recursive source dependencies recorded in `third_party-manifests/moonlight-android.json`. All files are ordinary Git files; `.gitmodules` declarations are retained as manifest text only. Upstream OpenSSL/Opus static archives are present in the imported snapshot; this is not evidence that those libraries were rebuilt here. Their production dependency provenance must be addressed in Android packaging.

Upstream `NvConnection` directly creates a GameStream connection and cannot be used as the platform admission path. Managed Android playback will use the existing gateway's WebRTC endpoint and shared upstream. The gateway already rejects legacy WebSocket streaming in managed mode; that restriction remains. No new Android-only renderer, bypass pairing endpoint, or second upstream is added.

Reuse the official Android native platform and gesture implementation through transport interfaces. `PointerInput` decouples the existing absolute/relative touch recognizers from `NvConnection` so a managed data-channel implementation can reuse them. Native WebRTC must handle peer negotiation, secure RTP and audio capture/playout; choose and pin its build dependency before APK integration. Do not reimplement RTP/DTLS or ship a WebView streaming wrapper.

## Admission and authority

1. Parse the same `/watch#key=...` capability used by Web. Send it only as a Bearer header to `/api/v1/watch/open`; never log it, include it in HTTP query strings or send administrator credentials.
2. Redeem the returned short-lived invitation with `/api/v1/client-sessions/join`. Check application identity; retain the connection credential for heartbeat, ticket, resume and leave operations.
3. Consume the existing revision/control-epoch snapshot, 5-second heartbeat and 15-second lease policy described in [connection lifecycle](client-connections/README.md). Media tickets authorize media admission; their role field does not overwrite heartbeat authority.
4. Join the gateway using native WebRTC with its existing SDP extensions, media-ticket authentication and `moonlight.control` data channel. Program audio and authorized microphone use the existing shared mixer and target routing.
5. Both server-side guards and native input/microphone gates apply. Revoke input and release physical recording on permission denial, authority loss, disconnect, background transition or stop. Ignore stale revisions and callbacks belonging to an interrupted session attempt. A resumed viewer never inherits controller authority.

`WatchLink`, `ConnectionAuthority` and `AuthorityState` implement the initial pure-Java boundary. They are not yet wired to an Activity, HTTP loop or transport. The network owner must drive authority refresh and expiry; a green reducer test does not prove capture is stopped on a device. Microphone capture requires an explicit user action, Android permission and current controller authority. Returning to foreground or reconnecting does not automatically restore recording consent.

## Configuration and product boundary

Use a distinct Stream Kit application ID, durable release signing key and version code for upgrades. Release TLS validates certificates and hostnames; private LAN CA trust needs explicit provision. Any development HTTP access is restricted to an explicit debug policy. No fake audio, Example, probing components, SDK tools or signing secrets are packaged with the production App.

The management page must identify Android versus Web while sharing connection lease and control policies. Address changes must resolve to a verified server identity before sending stored capabilities; numeric-IP bookmarks do not rewrite themselves. The existing pending LAN TLS/IP-change delivery items remain open.

## Verification

`JAVA_HOME=... node scripts/test-android-protocol.mjs` checks link credential isolation, viewer denial, permission denial, revision/epoch ordering, revocation, consent and stale callback suppression with JDK 17+. These are protocol unit checks, not Android integration acceptance.

The local official Android 16 x86_64 AVD `StreamKit_API_36` is for debug APK installation and end-to-end streaming/lifecycle checks. Native APK builds, on-emulator media, mixed Android/Web control transfer and audio, release signing and downloadable artifacts remain required. No physical mobile acceptance or repeated user speech session is imposed.
