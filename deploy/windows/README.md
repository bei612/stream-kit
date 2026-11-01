# Windows unified setup

The first-install wizard and silent mode use the same native `init-platform` and
`service` commands. Setup elevates once. It does not change PowerShell execution
policy or firewall policy and never reboots the machine automatically.
VB-CABLE packaging and installation support has been removed. The product
does not download it, request a vendor authorization record, or install it.
Existing compatible endpoints remain selectable through normal audio routing.

The free USB audio provider is being integrated. Its bundled installer branch
uses `orchestrator audio-driver install` inside the same elevated setup process.
The reviewed package contains only the usbip-win2 0.9.8.1 host-controller and
companion-filter INF/SYS/CAT files plus the BSD license (248,304 bytes total).
Both catalogs are checked with the official Windows SDK `signtool verify /kp` at
packaging time. The native installer verifies the same embedded file inventory;
the customer does not need Node, an SDK, a separate driver wizard or the vendor's
complete USB/IP application. No test certificate or test-signing policy is used.

The pinned signed runtime files are tracked in `deploy/windows/usb-audio-driver`;
the complete matching upstream source is in `third_party/usbip-win2`. Packaging
needs no vendor installer download. Only these seven runtime/license files are
eligible for inclusion, never the upstream GUI or development utilities.

Build selection is `--usb-audio-driver PACKAGE_DIR --signtool OFFICIAL_SIGNTOOL_EXE
--usb-audio-identity RELEASE_IDENTITY_JSON`
on `scripts/build-windows-installer.mjs`. An older control binary without the native
driver command is rejected before packaging. Product CI uses the committed
`deploy/windows/usb-audio-identity.json` profile by default: the freely shared
Audio class VID/PID `16c0:27e0`, with an owner-controlled email prefix. The
[published sharing rules](https://github.com/obdev/v-usb/blob/801242072fa035e1839e3571df0d9a18e9cec95c/usbdrv/USB-IDs-for-free.txt)
permit Audio class use with the system class driver and the prescribed device
namespace; this is not an exclusive allocation or a USB-IF certification claim.
No external PID application, paid driver or V-USB firmware is required.
The identity JSON contains integer `vendor_id`, `product_id` and optional
`serial_prefix` (required for this shared pair); it never supplies a fixed serial.
Namespaced initialization requires `virtual_audio_configuration_version: 2`;
older payloads are rejected even with `--reuse-payload`.

The same native `init-platform` operation receives the release identity, generates
a fresh 15-character random suffix after the release profile's prefix, and persists the complete serial in gateway
configuration before preflight. Driver installation then runs within the same
elevated installer, followed by service startup (or manual-reboot deferral).
Subsequent gateway restarts reuse that persisted serial. Customers do not need
to launch a device helper or manually edit the configuration after installation.

Installation serializes concurrent attempts, reuses a healthy matching existing
controller, and refuses incompatible/partial existing installations. DriverStore
staging omits `pnputil /install`; the native device install targets only its newly
created root node. The companion filter's upstream AddDevice handler attaches
only above the USB/IP virtual controller. On failure, cleanup is limited to the
new node, retaining potentially shared DriverStore packages. Windows-reported
restart requirements return 3010 and defer service startup; no automatic restart
is performed. Setup does not call an API to select system defaults, but Windows
can automatically select a newly created virtual output. This remains an open
delivery issue, not a guarantee that installation preserves the default devices.

Gateway configuration now includes `virtual_audio` (default `null`). When enabled,
its `vendor_id`, `product_id` and stable `serial` identify the deployment's USB
audio device. These values have no fabricated production defaults; the test
identity used in unit tests is not a production assignment. The unified management
page edits these fields and marks them as gateway-restart settings. Linux rejects
this Windows-specific provider and continues using native PulseAudio provisioning.

The gateway starts the provider before serving requests and releases its own
attachment when startup fails or the server shuts down. Device work runs off the
async server thread. Configuration inspection and native device enumeration do
not start the provider or install anything. Render/capture selection continues
through the existing explicit endpoint routing. This explicit routing does not
prevent Windows from automatically changing its default output during attachment.
The bounded `components/audio-target/examples/virtual_device.rs` utility is for
development only and is excluded from runtime packages.

An unexpected native transport exit now drains the gateway and releases its
owned attachment; the existing component supervisor applies the configured
restart policy. Normal stop continues to use the same bounded cleanup path.

Windows recording privacy applies to the configured interactive render account,
including virtual recording endpoints. If opening an endpoint reports access
denied, enable microphone access and desktop-app microphone access in Windows
Settings for that account. Driver installation alone does not grant recording
consent; see [Microsoft's microphone permission instructions](https://support.microsoft.com/en-us/windows/privacy/turn-on-app-permissions-for-your-microphone-in-windows).
Customer installers do not change these privacy settings. The separate
GitHub-hosted synthetic fixture configures its disposable test user only, after
requiring an empty sound-device inventory and an allowing machine policy; it is
never used on customer machines. See
`docs/evidence/windows-ci-recording-access-20261101.json` for the before/after
Windows API status and actual PCM result.

**Native device acceptance completed on 2026-11-01:** elevated installation created
one healthy controller with its companion filter, without reboot. Both endpoints
enumerated and retained their IDs across restarts. Actual 48 kHz playback/capture,
post-clear silence and clean device release passed. The software cable uses
line-level terminal descriptors so Windows does not apply physical-microphone
voice enhancement to already-processed remote PCM. Its two streams share one USB
frame clock and a per-connection high-resolution Windows waitable timer.
The local CPAL source fixes first-packet discontinuity handling; genuine later
capture errors still fail acceptance. See `docs/evidence/windows-native-audio-installed-20261101.json`.

**Gateway-owned recording completed on 2026-11-01:** the source-built gateway at
`525b1377` delivered browser-generated microphone PCM through this provider into
UE5 AudioCaptureCore. Two browsers shared one upstream; controller delivery,
transfer, viewer/old-controller/released rejection and audience mixing passed.
All five UE5 phases reported zero dropped capture frames. This route did not use
VB-CABLE. The previously accepted encoder/example were retained for this focused
integration run, so it is not a matching-revision release-bundle acceptance.
Evidence: `docs/evidence/browser-native-audio-ue5-20261101.json`.

**Still required before a public provider release:** the release identity decision
and complete unified installer run. Generated PCM does not
establish physical human speech acceptance. The published
runtime-only installer is unchanged.

The wizard accepts a program directory, a separate new data directory and the
single administrator's credentials. Internal media credentials and the shared
media ticket key are generated independently. Initial listeners are private:
control `127.0.0.1:9000`, gateway `127.0.0.1:8080`, Sunshine base port `47989`.
Configure browser-accessible HTTPS and media networking in the management page
before remote use. Application selection, host pairing and audio routing remain
deployment settings; installing files does not constitute media acceptance.

Native initialization verifies all three component inventories and matching
source revisions before invoking binaries. It resolves the desktop session's
actual user, including when elevation uses a different administrator account.
Only an active session with the configured SID is accepted. The LocalSystem
control service subsequently uses its existing authenticated user-session worker.
Configuration for the control service is restricted to administrators/System;
the rendering user receives access only to media/app/temp directories. Data is
prepared in a protected sibling staging directory, checked, then renamed into
place. Failed staging directories remain protected for diagnosis.

Existing program/data directories or service registrations are refused. This
installer does not yet implement in-place upgrades or database rollback.
Uninstall stops and removes only its matching native service and retains runtime
data. Native `service start` waits for SCM Running and then up to 90 seconds for
the control health response to match the installed build, with every configured
autostart component running and each managed process reporting a positive PID.
The probe connects directly without proxies or redirects; HTTPS verifies the
configured server certificate and its identity. A service-start failure attempts
to remove the service created by setup and
retains data/logs; cleanup failure is reported rather than force-killing processes.

## Silent installation

From an elevated deployment context:

```powershell
.\stream-kit-preview-COMMIT-windows-amd64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART /DIR="C:\Program Files\StreamKit" /DATADIR="C:\ProgramData\StreamKit" /ADMINFILE="C:\protected\administrator.json" /SESSIONID=1 /USERSID="S-1-5-21-..."
```

`ADMINFILE` is optional. Without it, silent setup generates a unique administrator
password in the administrator/System-protected `orchestrator.json` data file.
No shared default password is used. When supplied, `ADMINFILE` contains JSON
`name` and `password` fields and must be readable only
by the installer administrator. The caller owns and removes this supplied file.
Credentials are not command-line values. Interactive setup instead creates and
removes a private temporary credential file. A deployment agent running in
Session 0 must supply both the target session ID and SID; normal interactive
installation resolves them from its current desktop session. The data parent
must already exist. Silent mode preserves nonzero setup failure codes and never
automatically reboots.

Override initial listeners using `/CONTROLPORT=19000 /GATEWAYPORT=18080
/RENDERERPORT=48989`. Native initialization derives component URLs, health checks,
and browser origins from these values together and rejects overlapping native
TCP listeners. Normal defaults remain 9000, 8080, and 47989. The management
shortcut follows the selected control port. These options also allow deployment
beside an existing development instance without stopping it.

Initialization probes the control/gateway TCP listeners and Sunshine's native
TCP (-5, 0, +1, +21) and UDP (+9, +10, +11) offsets before creating runtime data
or credentials. A busy listener reports its component, protocol and port. The
temporary probes close on success and failure; they are not persistent port
reservations. Later startup races remain covered by service readiness. Setup
surfaces bounded listener/readiness diagnostics in its error and installation
log without copying general child configuration output or credentials.

## Build

`windows-product-release` is the unified GitHub Actions build entry point. Manual
dispatch builds the three runtime components and one installer as downloadable
artifacts. After a successful run, push a new `v*-preview.*` tag at that run's
source commit through the project's authorized Git transport, then dispatch the
workflow with `promote_run_id` and `release_tag`. Promotion verifies both native
installers and the source SBOM, and publishes those exact files without building
again or replacing release assets. Tag pushes do not start new builds in the
current workflow. The default Actions token uploads the release; it does not
need a deploy key or an additional workflow-writing OAuth grant. The
workflow uses the same checked-in builders as local packaging. CMake 3.31.8 and
Inno Setup 7.1.1 come from their official releases with locked SHA-256; Inno's
publisher signature is checked before running the build-tool installer. Node,
Go, Rust, MSVC and MSYS2 are installed on the temporary CI build host, never by
the product setup on the deployment host. Build success does not certify host
installation, GPU/audio hardware or physical microphone acceptance. The MSYS2
package inventory is retained with logs; changing distribution repositories are
not claimed to produce byte-identical binaries.

The unified workflow shares a Cargo output directory across native components,
the official binding generator and its WASM shim. Dependency cache entries are
retained if a later step fails. Cargo still resolves the locked dependencies and
the release builders still compile workspace binaries and verify source stamps;
cached objects do not replace successful build or acceptance results. The cache
policy follows [rust-cache's documented inputs](https://github.com/Swatinem/rust-cache).

MSVC (Rust dependencies) and UCRT/MinGW (Sunshine/codecs) use separate compiler
search environments. The renderer build clears inherited MSVC SDK library and
include variables in its child shell; its CI step inherits minimal Windows paths
and adds only the official CMake and selected Node build-tool directories.
The first full CI reached codec-probe linkage but selected Microsoft SDK import
libraries through MSVC's `LIB`, producing GUID multiple definitions. An isolated
local reproduction failed under the inherited context and passed with the
production UCRT adapter, retaining all nine codec registrations. Evidence:
`docs/evidence/windows-ucrt-library-context-20261101.json`. This does not mark
the failed full CI run as successful; the corrected workflow still needs its
own complete result.

Use the official Inno Setup 7.1.1 distribution. Its license and commercial-use
information are available at https://jrsoftware.org/isorder.php and in the
compiler distribution; no compiler binary is vendored in this repository.

```text
node scripts/build-windows-installer.mjs PLATFORM_BUNDLE NEW_OUTPUT OFFICIAL_ISCC_EXE
```

The platform must be assembled from clean, matching source-built components at
the current commit. The control manifest must declare initialization version 1.
Both installers require exactly control, media gateway and Sunshine. The shared
installer policy rejects example components, acceptance directories, development
toolchains and test executables, even when their file hashes are self-consistent.
There is no example shortcut in a customer installation. Assemble the runtime
with `node scripts/package-platform-release.mjs CONTROL GATEWAY RENDERER OUTPUT`.
Developers may separately build the audio/video example using
`node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY`; it remains an
independent diagnostic artifact and is not an installer input. UE SDK probes,
Playwright and acceptance scripts are also development-only. Historical preview
releases that included an example are not relabeled as production releases.
The builder verifies payload hashes and records the resulting installer hash,
compiler hash and source revision. The executable is currently unsigned and the
channel remains preview. Publisher code signing is not required by the current
delivery scope; the absence of a commercial signing certificate is not a release
blocker. Compilation/unit tests are not installation acceptance. The installer
recipe `4b3b418c` with payload `c5522af9` passed real silent install, administrator
login, LocalSystem control service and both media components running, and silent
uninstall with runtime data retained. See
`contracts/windows-installation/20261031.json`. A separate SCM streaming run
failed its final missing gateway-log archive check; the original failure is
retained. `20261031-scm-supplement.json` independently verifies its generated
microphone/target/audience metrics and exactly one native Sunshine connection.
It does not turn the failed automation task green or prove a newer release,
physical microphone delivery, or bundled-driver/reboot acceptance.

For an installer-only correction, append `--reuse-payload` to reuse an immutable,
hash-verified platform bundle instead of recompiling its executable components.
The Windows product workflow retains this input as the internal Actions artifact
`windows-product-payload-<commit>` for seven days, before compiling the installer.
Download that artifact into a new directory when reviewing an installer-only
change. The builder rechecks every file against the payload manifest and records
the payload and installer source revisions separately. This artifact is not
uploaded to customer Releases; the public Windows download remains one installer.
All payload components must still have the same payload source revision. The
installer manifest records `commit` for that payload, `installer_source_commit`
for its clean setup recipe, and `reused_payload`; the EXE filename gains the
recipe revision suffix. Reuse does not claim that older binaries contain newer
runtime changes. It is for explicitly reviewed installer-only releases.

## Native Windows runtime dependencies

The production Windows bundle packages the imported Microsoft release CRT
beside the gateway. The shared packager reads dependencies with
the initialized MSVC toolchain, checks architecture and Microsoft's valid
Authenticode signature, and includes the unmodified redistributable files,
copyright notice and `WINDOWS-RUNTIME.json` in each component's hash inventory.
It uses the toolchain's release redist directory, never System32/debug files.
The packaged gateway's version is checked afterward. Developer audio-probe
bundles use the same dependency packager separately; the probe, its startup
check and its test fixtures are excluded from the customer installer.
No host-wide Visual C++ installer or Node.js installation is invoked. This is
[Microsoft's application-local redistribution model](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files).

## Promote an existing CI product build

For a stable candidate, dispatch `windows-product-release.yml` with
`release_version=MAJOR.MINOR.PATCH`. An empty version retains preview behavior.
The optional `usb_audio_identity` input overrides the committed product profile
with integer `vendor_id`, `product_id` and optional `serial_prefix` fields.
Without an override, the shared Audio class profile is used and the pinned,
signed virtual-audio controller is included in the same installer.
The workflow validates this input before compilation and uses the initialized
official Windows SDK signature tool to verify the payload. The installer creates
a persistent serial for each installation; CI fixture identities and test
executables are not substituted into this input. Selecting this profile is not
evidence of exclusive identity allocation or completed installation acceptance.
The shared product identity sets both installer filenames, Windows product/file
versions, Debian package version and manifest channel/version. This selects
packaging metadata; it does not claim deployment or audio acceptance has passed.

Dispatch the same workflow with `promote_run_id` and a new `release_tag` to publish
existing artifacts. A stable tag must be exactly `vMAJOR.MINOR.PATCH` matching both
installer manifests. A preview uses its matching `v0.1.0-preview.DATE.N` tag and
remains a GitHub prerelease. A product built with an explicit final version may
first be published as `vMAJOR.MINOR.PATCH-rc.N` (positive N), always marked as a
GitHub prerelease. Its installer version and bytes remain unchanged; final
publication can later promote the same successful build after remaining checks
are completed. This does not convert a preview payload into a stable payload.
Candidate publication requires reviewed `deploy/releases/MAJOR.MINOR.PATCH-rc.N.md`
notes committed in the publication revision, stating the artifact source and
remaining acceptance. The workflow tests promotion rules before uploading and
records the publication revision separately from the immutable build/tag source.
Promotion cannot relabel preview artifacts as stable,
mix channels/versions, or change the bytes. Promotion requires a completed successful manual product run on
main, checks its repository/workflow/source revision, both native installer
manifests/checksums and source SBOM, then publishes those existing artifacts.
It does not rebuild executables or repeat acceptance. The tag identifies the
payload's commit, even if the promotion workflow was subsequently improved.
Failed/cancelled runs and mixed revisions are rejected. Existing releases are
not overwritten; an existing tag is reusable only for the exact same commit.
Using the repository token prevents recursive tag builds, as described in
[GitHub's triggering documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
