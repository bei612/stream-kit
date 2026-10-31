# Media gateway bundle

This directory contains the native gateway and its rebuilt viewer Web/PWA
assets. Keep `dist` beside the executable and use this directory as the gateway
working directory. Set an absolute external configuration path using the
gateway's supported command-line options. Keep credentials, certificates and
runtime data outside the immutable release directory.

Build from a clean checkout with the repository's pinned native Rust, Node and
wasm-bindgen toolchains and installed lockfile dependencies:

```
node scripts/build-gateway-release.mjs --output artifacts/release/gateway-VERSION
```

The build regenerates API bindings and WebAssembly, builds the optimized native
executable and viewer, and records SHA-256 hashes and the source commit in
`bundle-manifest.json`. It refuses to replace an existing output directory or
issue a manifest if the source changes during the build. A failed output is
incomplete and must not be deployed.

`THIRD_PARTY_NOTICES.rust.json` includes separate native and WebAssembly Cargo
dependency graphs, declared license expressions, available license texts and
their hashes. It excludes dependencies reachable only through development edges
and conservatively includes build dependencies. This graph is not a final binary
symbol inventory. `missing_notice_packages` explicitly lists packages whose
available source package does not contain a license text; a successful preview
build does not declare these omissions resolved or replace a license review.
The collector never obtains license texts from the network during a build.

Configure the Orchestrator's `web_server` component with the packaged executable,
this working directory and the external configuration arguments. The source and
receiver gateways must use compatible control contracts and distinct configured
node secrets. The Orchestrator manages their lifecycle; this package does not
install a second independent service supervisor.

## Offline administrator initialization

For a new installation, create the protected external data directory, generate
the native configuration, set `web_server.first_login_create_admin` to `false`
and set `data_storage.path` to a new file in that directory. Invoke:

```
web-server.exe --config-path ABSOLUTE_CONFIG initialize-admin
```

The deployment process supplies one JSON object on standard input with `name`
and `password` fields, then closes the pipe. Do not place credentials in command
arguments or logs. The password must contain 12–1024 UTF-8 bytes. This command
creates one administrator using the runtime's password hashing and storage
schema, flushes the data before returning, and starts no HTTP listener, media
component or asynchronous writer. Existing storage is never overwritten, even
when empty or invalid. The parent directory must already exist with appropriate
permissions (on Windows the new file inherits its parent's ACL). A write failure
leaves an incomplete file for inspection and does not report successful setup.

This is an installation operation, not a password reset or upgrade command.
Normal deployments continue to use the single platform administration page;
the gateway credential is an internal control-plane connection credential.

For upgrades, prepare a new directory, stop admission and active sessions through
the management service, stop the managed gateway, update its executable and
working directory together, and restart it. Preserve the previous release and
external configuration for rollback. Do not replace a running executable in place.

The inventory is an integrity record, not a publisher signature. Included npm
notices and dependency locks do not constitute complete native dependency license
clearance or a platform installer. Sunshine, the control service and any required
audio device driver are separate components of the platform distribution.
