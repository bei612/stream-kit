# Android managed client integration

The client is a signed native Android fork, not an upstream GameStream connection or a WebView viewer. Published APK identity and actual device/emulator evidence are maintained in [release status](../docs/release-status.md); user operations are in [Android controls](../docs/android-viewer-controls.md).

## Source and shared transport

Official Moonlight Android v12.2 and recursive source dependencies are imported as ordinary files under `third_party/moonlight-android`; provenance is recorded in `third_party-manifests/moonlight-android.json`. Retained upstream OpenSSL/Opus static inputs are not evidence that this project rebuilt those libraries.

Managed playback uses the gateway's WebRTC endpoint and shared renderer upstream. It does not use upstream NvConnection as a separate admission path, does not add an Android-only encoder, and does not bypass managed mode's rejection of legacy WebSocket streaming.

Upstream native platform, gesture recognition and keyboard translation are reused through transport adapters. `PointerInput` separates touch recognizers from NvConnection; `ManagedInput` emits existing gateway input packets. GFE-prefixed `0x80xx` virtual keys are normalized to canonical Windows keys consistently for down/up; invalid values are rejected.

## Admission

1. Parse the same HTTPS `/watch#key=…` capability as Web. Submit it only in the Authorization header to `POST /api/v1/watch/open`; never log it or send administrator credentials.
2. Redeem the short-lived invitation at `/api/v1/client-sessions/join`, validate application identity and retain the scoped connection credential.
3. Use that credential for current state, heartbeat, resume, leave and media-ticket requests. A 5-second heartbeat maintains the server's 15-second lease.
4. Create native WebRTC using the gateway's existing SDP extensions, WHEP resource ownership, media-ticket authentication and `moonlight.control` channel.
5. Program audio, microphone mixing and target routing use the existing shared gateway path. Media-ticket role does not overwrite authoritative heartbeat permissions.

`WatchLink`, `ManagedApi`, `ManagedSession`, `ConnectionAuthority` and `AuthorityState` separate parsed capability, HTTP transport and current session ownership. Managed HTTP disables redirects, bounds responses and validates WHEP resources against the expected gateway, keeping credential purposes isolated.

## Authority and input

Only the current server-assigned controller can send input or microphone. Native gates and gateway enforcement both apply. Gateway control polling captures the current ControlGrant at decode time and checks it again before upstream forwarding; a queued packet cannot be re-authorized after A→B→A transfer.

Pressed keys, mouse buttons and gestures are released on focus loss, toolbar/input transitions, backgrounding and stop. Callbacks belong to the owning session/generation; an old gesture cannot release a new gesture's input or revive an old connection.

## Recording consent and audio

Microphone requires an explicit gesture and Android permission. Each gesture creates an opaque single-use authority request; permission callbacks must match session owner, generation and consent sequence. Transfer, policy change, focus loss, background and reconnect invalidate pending requests; unchanged heartbeats do not. A stale denial cannot disable a newer valid request.

Permission denial, authority loss, network lease expiry, background transition and stop release recording. Resumed connections join as viewers; obtaining control or foreground/audio focus does not automatically restart capture. Native WebRTC handles capture/playout and independent AEC/NS/AGC settings; client input-device IDs are not server audio-target IDs.

Program output uses the shared supported 48 kHz stereo media configuration. Statistics and packet receipt are not proof of audible output or target recording. Do not change system volume or add production probes to force an acceptance result.

## Recovery and terminal state

The [connection contract](client-connections/README.md) is authoritative:

- `CONNECTION_LEASE_EXPIRED` permits recovery of the same unexpired credential/identity with authority disabled.
- `CONNECTION_TERMINATED` closes media, input and recording and stops automatic resume/readmission.
- Legacy `CONNECTION_EXPIRED` may attempt same-identity recovery; a definitive resume 401/410 ends it.
- Network failures use bounded requests and existing low-frequency recovery without restoring authority.
- Late responses from superseded operations/credentials cannot terminate a replacement connection.

An explicit new opening of a valid permanent link can start another admission after a terminal state; the client does not silently perform it.

## UI, settings and credentials

`ViewerChrome` owns the collapsible toolbar and role display, `ViewerSettings` local preferences, `ViewerPointer` / `RemoteKeyboard` native input adaptation, and `NativePeer` the media peer. Local UI/playout options remain usable for viewers; control and recording operations are disabled without authority.

Address editing changes the HTTPS server origin while preserving the saved capability. Credential persistence is separate from ordinary preferences; secrets do not appear in diagnostic logs. Trust uses Android's configured certificate model, never permissive hostname verification.

## Build and acceptance

Use the project Gradle Wrapper and pinned SDK/JDK/NDK. Windows uses `gradlew.bat`; CI executes release-variant HTTP/unit boundaries and native debug compilation separately from the signed release workflow. Test-only HTTP fixtures are not production interfaces or integration evidence.

Release uses the persistent project signing key and increasing versionCode; signing material stays outside source and APK. Verify package inventory, native libraries, signature and provenance. Actual admission, media, target input, control transfer/revoke, recording, foreground/background and network recovery require the produced APK in an emulator/device.

Current evidence retains its precise server/runtime versions. Physical audio quality and vendor-device behavior are not inferred from simulator checks; known Linux emulator audio failures are not erased by Windows success.
