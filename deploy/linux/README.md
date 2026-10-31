# Linux unified deployment

The native `init-platform` command now shares credential generation, listener
validation, component verification and configuration preparation with Windows.
The source pipeline assembles those native components into one silent-first
Ubuntu 24.04 amd64 installer. A candidate is delivered only after its workflow
has completed; source changes alone do not establish a downloadable or accepted
package. Linux hardware acceptance is excluded from the current scope.

## Single installer

```sh
sudo bash stream-kit-preview-COMMIT-ubuntu24.04-amd64-setup.run --user RENDER_USER
```

Select the existing non-root desktop/audio session owner explicitly. The file
contains a hash-verified Debian payload with all three native components and
Web assets. Apt resolves distribution runtime libraries without confirmation;
Node.js, npm, Go, Rust and CMake are not runtime prerequisites. Distribution
package repositories must be available if required native libraries are absent.
The installer checks the target distribution, user and session before package
installation, then initializes private data and enables a single systemd user
service. It prints the protected credential file location, never its contents.

Use `--no-start` when installing without an active desktop session. This prepares
data but does not claim service/media readiness; after logging into the desktop,
run `systemctl --user enable --now stream-kit.service`. The systemd user manager
must have the desktop's DISPLAY/WAYLAND environment and access to the selected
PulseAudio/PipeWire devices. Initialization needs no GPU or open audio stream.

Program files are under `/opt/stream-kit`; data is under the rendering user's
`$HOME/.local/share/stream-kit/runtime`. Upgrades validate and retain existing
configuration instead of regenerating administrator credentials. Back up this
data before updating. `sudo apt-get remove stream-kit` stops/disables the recorded
owner's service when its user manager is available and preserves data. No other
user is auto-selected. Package files include Sunshine's input-device uaccess
rules and uinput/uhid module configuration; active installation reloads only
those factory device rules. KMS CAP_SYS_ADMIN is not granted automatically.

Windows keeps its single setup EXE; each server OS has one native installer.
The unified release workflow requires both package builds and source SBOM before
publishing a tagged preview. The Linux package check extracts the actual payload,
executes all three components through initialization, validates its private
configuration and checks refusal to replace existing data. It neither installs
onto the CI host nor claims hardware streaming acceptance.

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

`orchestrator verify-platform DIRECTORY` performs read-only native verification
of the complete platform: component identity, required runtime files, hashes and
matching source revisions. Packaging and installation use the same verifier.
The private Vulkan loader's license accompanies its binary in the renderer
component inventory. Archive applications accept native ELF programs and Unix
launch scripts; selection grants owner execution only to the chosen uploaded
entry. Existing local programs must already be executable and are not changed.

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
