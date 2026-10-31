# Linux unified deployment

The native `init-platform` command now shares credential generation, listener
validation, component verification and configuration preparation with Windows.
The Linux product installer and a renderer bundle using the following layout
are still in development; this interface is not a claim that a complete Linux
installation package has been delivered or accepted.

## Runtime layout

The canonical catalog is
`orchestrator/internal/bundle/layouts.json`, embedded in the native verifier and
read by the platform packager. Linux keeps Sunshine's executable in
`sunshine/bin/sunshine`, its Web/resources in `sunshine/share/sunshine`, and its
private loader libraries in the renderer's native library tree. The gateway is
`media-gateway/web-server`; the management executable and Web assets remain in
`orchestrator/`. The packager and initializer use the same catalog. Windows
retains its existing flat executable layout.

`SUNSHINE_PACKAGE_LAYOUT=platform` selects the source build profile consumed by
the same renderer verifier. It stages through native CMake `DESTDIR`, preserving
bin/lib/share and checking installed source identity, dependencies and the
private Vulkan loader. The full Linux source CI now exercises this layout and
the executable-relative resource resolver. Its result must be confirmed before
claiming that this renderer bundle is accepted.

## Native initialization

Run as the non-root user that owns the rendering and audio session. A package
manager may install immutable files with elevated privileges; initialization
does not run media applications as root or impersonate another user.

```sh
install -d -m 700 "$HOME/.local/share/stream-kit"
/opt/stream-kit/orchestrator/orchestrator init-platform \
  --root /opt/stream-kit \
  --data-dir "$HOME/.local/share/stream-kit/runtime"
```

The data parent must already exist. Its ancestors must preserve ownership;
shared writable parents are rejected, while root-owned sticky ancestors such
as `/tmp` are allowed above a private parent. Program and data directories must
be separate. Windows SID/session flags are rejected on Linux. A complete,
same-commit native platform is verified before invoking either media executable.

Credentials are generated independently for the single platform administrator
and internal media connections. Optional `--admin-file` supplies a private JSON
file; credentials are piped to native initialization commands, never passed in
process arguments. Default listeners are loopback-only and use ports 9000/8080/
47989; `--control-port`, `--gateway-port` and `--renderer-port` configure them as
one deployment. Remote browser microphone capture requires HTTPS and browser
permission.

Staging and media directories are private to the rendering user. Failed staging
is retained privately for diagnosis. Successful initialization uses Linux
`RENAME_NOREPLACE`, including refusal to replace an empty existing directory,
and syncs the parent directory. An unsupported filesystem/kernel returns failure
rather than falling back to replacement. No service, listener or audio stream is
started by initialization. Service readiness and actual media acceptance remain
separate checks.

## Validation scope

Windows Go tests and the cross-platform packaging contract checks run locally in
native Windows; Linux-specific code is cross-compiled there. Linux CI runs the
native ownership, permission, atomic publication and configuration tests. Linux
hardware acceptance is excluded from the current delivery scope; compilation or
filesystem tests do not establish GPU capture, real microphone or UE5 delivery.
