# Android managed client integration

Status: implementation in progress, not an APK delivery claim. Scope: [current goal](../docs/goal-current.md).

## One managed session and transport

The Android fork lives in `third_party/moonlight-android`, pinned to official v12.2 with recursive source dependencies recorded in `third_party-manifests/moonlight-android.json`. All files are ordinary Git files; `.gitmodules` declarations are retained as manifest text only. Upstream OpenSSL/Opus static archives are present in the imported snapshot; this is not evidence that those libraries were rebuilt here. Their production dependency provenance must be addressed in Android packaging.

Upstream `NvConnection` directly creates a GameStream connection and cannot be used as the platform admission path. Managed Android playback will use the existing gateway's WebRTC endpoint and shared upstream. The gateway already rejects legacy WebSocket streaming in managed mode; that restriction remains. No new Android-only renderer, bypass pairing endpoint, or second upstream is added.

Reuse the official Android native platform and gesture implementation through transport interfaces. `PointerInput` decouples the existing absolute/relative touch recognizers from `NvConnection`; `ManagedPointer` adapts them to the existing gateway input packets. The pinned native WebRTC library handles peer negotiation, secure RTP and audio capture/playout. No WebView streaming wrapper is used.

## Admission and authority

1. Parse the same `/watch#key=...` capability used by Web. Send it only as a Bearer header to `/api/v1/watch/open`; never log it, include it in HTTP query strings or send administrator credentials.
2. Redeem the returned short-lived invitation with `/api/v1/client-sessions/join`. Check application identity; retain the connection credential for heartbeat, ticket, resume and leave operations.
3. Consume the existing revision/control-epoch snapshot, 5-second heartbeat and 15-second lease policy described in [connection lifecycle](client-connections/README.md). Media tickets authorize media admission; their role field does not overwrite heartbeat authority.
4. Join the gateway using native WebRTC with its existing SDP extensions, media-ticket authentication and `moonlight.control` data channel. Program audio and authorized microphone use the existing shared mixer and target routing.
5. Both server-side guards and native input/microphone gates apply. Revoke input and release physical recording on permission denial, authority loss, disconnect, background transition or stop. Ignore stale revisions and callbacks belonging to an interrupted session attempt. A resumed viewer never inherits controller authority.

`WatchLink`, `ConnectionAuthority` and `AuthorityState` implement the pure-Java authority boundary. `ManagedApi` now implements the admission, heartbeat, resume, ticket, leave and WHEP HTTP adapter with isolated credentials, disabled redirects, bounded responses and same-gateway resource checks. `NativePeer` implements native WebRTC receive tracks, a microphone sender and a gated control data channel, reusing upstream `StreamConfiguration`. It disables both physical recording and the sending track on microphone stop. The native library and notices are pinned in `third_party-manifests/android-media.json`.

`ManagedSession` owns asynchronous admission, heartbeat, authority expiry, reconnect and late-result cleanup. `ManagedActivity` presents native video, permission controls and the upstream absolute-touch recognizer. Backgrounding leaves the connection and releases capture; returning rejoins as a viewer. Audio-focus loss disables capture and playout. Microphone capture requires an explicit user action, Android permission and current controller authority. Returning to foreground or reconnecting does not automatically restore recording consent. First-frame visibility is tracked per peer so a reused renderer cannot leave the link editor visible after reconnect.

## Configuration and product boundary

Use a distinct Stream Kit application ID, durable release signing key and version code for upgrades. Release TLS validates certificates and hostnames; private LAN CA trust needs explicit provision. Any development HTTP access is restricted to an explicit debug policy. No fake audio, Example, probing components, SDK tools or signing secrets are packaged with the production App.

The management page must identify Android versus Web while sharing connection lease and control policies. Address changes must resolve to a verified server identity before sending stored capabilities; numeric-IP bookmarks do not rewrite themselves. The existing pending LAN TLS/IP-change delivery items remain open.

## Verification

`JAVA_HOME=... node scripts/test-android-protocol.mjs` checks link credential isolation, viewer denial, permission denial, revision/epoch ordering, revocation, consent and stale callback suppression with JDK 17+. These are protocol unit checks, not Android integration acceptance.

`./gradlew :app:testNonRootDebugUnitTest :app:assembleNonRootDebug` compiles the native client and exercises the HTTP adapter using OkHttp MockWebServer in test scope only. Eleven JVM tests cover credential isolation, redirects, mismatched-identity cleanup, media-resource isolation, authority decoding, ICE quoting and input wire packets. Valid upstream `StreamConfiguration` construction loads Android JNI and is exercised on the emulator, not in the Windows JVM.

The local official Android 16 x86_64 AVD `StreamKit_API_36` runs with WHPX. A native debug APK opened the existing Example permanent link, started the application and displayed actual decoded frames. A confirmed HOME/background/foreground transition returned to viewing with microphone disabled and the link entry hidden on the new peer's first frame. See `docs/evidence/android-native-viewer-20261106.json`. This used debug HTTP through the emulator host alias; it does not prove release TLS, audio, controller input or physical-device behavior. Mixed Android/Web control transfer and audio, durable credential storage, release signing and downloadable artifacts remain required. No repeated user speech session is imposed.
