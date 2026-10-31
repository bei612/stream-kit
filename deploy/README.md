# Stream-Kit service deployment

Gateway revision `aa4f4574` passed the Linux CI browser audio checks in
[job 124507123027](https://github.com/bei612/stream-kit/actions/runs/41190831790/job/124507123027):
Chromium/Firefox and WebKit playback plus microphone RTP lifecycle, including
revocation/reacquisition, and all three viewer asset/WASM checks. The browsers
used the isolated real PulseAudio fixture. This confirms the WebKit initial
interrupted-context test correction; it does not establish physical microphone
permission, mobile hardware, browser-to-UE5 recording or a signed installer.
The observed job was still building its gateway release, so this records only
the completed successful steps, not an overall job pass.

Before registering a Windows service, or on each systemd start, deployment runs
`orchestrator check-config --config PATH`. This validates the existing file with
the same environment overlay as startup and loads any configured TLS key pair.
It does not generate configuration, create storage, bind ports or start media
components. It does not test component availability or service-account access;
run it under the deployment identity/environment and verify actual service startup
separately. Windows installer preflight runs under the invoking account; SCM may
use a different account/environment.

Windows source revision `aa254605` completed the native Sunshine release build
with official CMake 3.31.8, clean-source verification and matching executable
revision. Its 71 selected core native tests passed without skips (capture target,
application management, configuration persistence and Windows audio behavior).
Build/test evidence: `artifacts/source-build/sunshine-aa254605/`.

The same revision's renderer, gateway, control bundle, example and rebuilt Web
assets passed Chromium application-stream acceptance at
`artifacts/source-stream/2026-10-31T09-50-06-672Z/`: two viewers, one upstream,
program tone, controller microphone-tone broadcast alongside program audio,
viewer/previous-controller rejection, control transfer, viewer departure,
application deletion and return to idle. The microphone source was a generated
test file and the target recording device was unconfigured. This does not prove
physical microphone permission, delivery to UE5/recorder, full audio quality,
installed-service operation or a signed platform installer.

The same Windows artifacts passed service recovery at
`artifacts/source-stream/2026-10-31T09-52-10-116Z/`: gateway recovery took
20.315 seconds without a page reload; control restart retained connection and
control-epoch identity while video continued. Renderer files were then staged
with `cmake --install` into a new local directory. With PATH restricted to
Windows system directories, the staged renderer passed full program streaming,
browser configuration editing and managed encoder restart at
`artifacts/source-stream/2026-10-31T09-54-04-561Z/`. Both clients recovered in
23.096 seconds, the loaded configuration revision matched, identities were
preserved, and program audio was measured after recovery. These checks use the
existing Windows host; they do not prove a fresh-OS installer or SCM session
deployment. No installed service or system default audio device was changed.
Gateway configuration application also passed with those staged artifacts at
`artifacts/source-stream/2026-10-31T09-56-05-845Z/`: the production form saved the
revision, rejected stale edits, restarted the owned gateway, verified its loaded
revision and configured UDP ports, and recovered both clients in 21.205 seconds
with program audio. The owned gateway was stopped during cleanup.

On 2026-10-31 the required stability duration was explicitly reduced from 24 to
4 hours. The 20-client run completed 16,280.012 seconds (about 4.52 hours), with
1,603 periodic samples verifying all connections, decoded-frame and audio-packet
progress, and the shared upstream. This stability requirement is complete.
Evidence is in `artifacts/source-stream/2026-10-31T05-01-53-785Z/four-hour-acceptance/`.
The original 24-hour harness was deliberately interrupted after the requirement
change; its later disconnect checks and graceful teardown are not claimed.
Only its 36 owned processes were stopped, with none remaining. This result does
not certify microphone delivery to a target application or audible audio quality.

The Linux native control bundle at `aa254605` passed the complete CI job,
including Go unit tests, race checks, clean release construction and real-browser
external-configuration/restart acceptance:
https://github.com/bei612/stream-kit/actions/runs/41188846438/job/124501261048.
This is native Linux CI runtime evidence, not physical-device or full media
installation acceptance. The same revision's local Windows control bundle also
passed at `artifacts/control-bundle/2026-10-31T09-31-15-394Z/`.
The same revision's Windows CI job subsequently passed too, including the
native control-bundle browser acceptance:
https://github.com/bei612/stream-kit/actions/runs/41188846438/job/124501260959.

The native gateway release entry point is `node scripts/build-gateway-release.mjs`.
It requires a clean commit, builds with the locked Cargo dependency graph, embeds
the full source revision and explicit dirty state, executes `--version`, and
rechecks source identity after the build. Cargo must be on PATH. Ordinary Cargo
builds without source metadata identify themselves as `unversioned-development`;
the upstream package version alone is not evidence of a Stream-Kit release.
This command builds the native executable only. Gateway browser assets, runtime
dependencies, notices and the complete platform installer remain separate
requirements; this source stamp does not certify those artifacts.

The Orchestrator CI artifact contains the executable and a sibling `dist/`
directory with the unified management page. Keep this layout when installing:
on Linux, both belong under `/opt/stream-kit/orchestrator/`; on Windows, both
belong under the install root passed to the service installer. Configuration can
remain in `/etc/stream-kit/` or `C:\ProgramData\StreamKit\` independently.

Without an explicit template, first run creates a random administrator credential,
loopback-only listener configuration, and disabled `sunshine` / `web_server`
entries, then exits for review. Their executable paths are empty; the generated
management form can configure both components without selecting an installed
upstream binary. Automatic startup requires a nonempty executable path. Component
paths and activation remain explicit deployment choices, and changes require a
control-service restart. Existing configuration and explicit templates are retained.
The clean Windows `35498585` bundle passed first-run generation, actual browser
login, component path editing, user-session settings and isolated control restart
at `artifacts/control-bundle/2026-10-31T08-50-11-441Z/`. Neither media component was
launched by that acceptance; this is not full platform installation acceptance.

After installing locked dependencies with `npm ci` in `orchestrator/web`, use `node scripts/build-control-plane.mjs`
from the repository root to build the control-plane bundle. `--go` selects the
Go executable and `--output` selects a new output directory. Existing output is
never overwritten. CI uses `--require-clean`, Go 1.27.3 and Node 26.4.0; a dirty
source tree is rejected before creating a release output. Local builds without
that flag are explicitly marked `-dirty` when appropriate.

The Go module now requires Go 1.26 or later. Windows worker pipe I/O uses
vendored Microsoft go-winio 0.6.4: concurrent `os.File` pipe reads and writes
triggered the upstream [Windows pipe offset race](https://go-review.googlesource.com/c/go/+/829144)
in the released runtime. The project uses the official Go 1.27.3 toolchain;
it does not patch the runtime or disable race checking. Worker lifecycle tests
include bidirectional traffic and idle heartbeats beyond the 30-second timeout.

The executable reports its source commit and version. The embedded build stamp
is the source commit timestamp for reproducibility, not wall-clock packaging
time. `bundle-manifest.json` records the commit, dirty state, target, Go version,
and SHA-256/size of every executable and page asset. The builder type-checks and
builds the page directly into the new bundle, then builds the executable; it
never copies a potentially stale `web/dist`. The manifest also records Node,
TypeScript and Vite versions and the frontend lockfile hash. Installed TypeScript
and Vite must match the lockfile. Release builds recheck the source revision and
clean worktree before issuing a manifest. Existing deployment assets are untouched.
The binary's Go build metadata must also agree on `vcs.modified`; a clean-tree
manifest cannot be issued for a binary that records modified sources, and missing
modification metadata is rejected. Explicit development builds retain `-dirty`
and cannot pass installation verification.

Native Sunshine builds support `SUNSHINE_BUILD_NAME=cmake-build-sunshine-release`
with `scripts/build-sunshine.sh`. The named directory stays under `.local/` and
must begin with `cmake-build-`; the default remains `cmake-build-sunshine`.
Use a separate directory when an existing binary is serving acceptance traffic.
Dependency builds still use the common source dependency directory. This option
does not stop, replace or install an existing service.
Set `SUNSHINE_REQUIRE_CLEAN=1` for a release build. This rejects dirty sources
before dependency compilation, retains the initial commit throughout the build,
and rejects a changed commit or worktree at completion. It then executes the
native binary's version command and reports its matching revision and SHA-256.
Without this flag the script remains a development build entry point; successful
compilation alone does not qualify its output as a release. Runtime version and
hash checks are not installer, dependency-closure or publisher-signature checks.
Hashes identify the packaged bytes; the manifest is not a signature, SBOM or
proof that the complete platform has passed acceptance.

`node scripts/accept-control-bundle.cjs BUNDLE_DIRECTORY` runs the native bundle
with an isolated external configuration, database, random administrator credential
and loopback port. A real browser checks login and the packaged sibling management
assets, saves both renderer and gateway user-session settings, verifies rejection
of incomplete/stale writes, then restores direct launch and restarts only its own
control process. It verifies the immutable package before and after the run and
requires both media components to remain unstarted. It neither installs a service
nor validates audio/capture. Windows execution of the clean `ba07b312` bundle passed
at `artifacts/control-bundle/2026-10-31T07-30-29-029Z/`; the Linux bundle was only
cross-compiled locally. Both native CI jobs now run this package acceptance.

Run `orchestrator verify-bundle DIRECTORY` (or `orchestrator.exe` on Windows)
before installation. The command is read-only and starts no server. It requires
a clean release manifest matching the verifier's platform/architecture, checks
every listed file's size and SHA-256, rejects missing or extra files and linked
or special entries, and requires the executable, management entry page and both
Go/frontend notice inventories. Relative paths cannot escape the package root;
case-colliding entries are rejected on both platforms. Keep configuration,
databases and logs outside this immutable package directory. Verification assumes
the package is not being concurrently modified during installation.

Current manifests declare `verification_version: 1`. Native clean builds run
their own verification command before reporting success; cross-compiled bundles
require verification on the target platform. The Windows installer checks this
capability and verifies the package before creating, reconfiguring or starting
the service. Older bundles must be rebuilt before using the current installer.
The verifier and installer must themselves come from a trusted distribution;
an unsigned manifest and its hashes do not establish publisher identity.

2026-10-31 local checks cover changed bytes, changed sizes, missing/extra files,
target mismatch, dirty builds, path escape and duplicate entries. A compiled
Windows verifier also checked the existing clean `b75c6fe9d368` bundle (8 files).
The symbolic-link test was skipped locally because this account cannot create
symlinks; it remains enabled for Linux CI. No SCM installation was performed.

The Linux systemd unit now runs the same verifier through `ExecStartPre` on
every start, before opening the control-plane listener. Three starts within
60 seconds trigger the unit's start limit, preventing a damaged package from
entering a tight restart loop. Deploy this unit with a current bundle declaring
`verification_version: 1`; do not pair it with an older executable that lacks
the command. Source cleanliness must be explicitly `false` for `source_dirty`
(missing or null is rejected), and the version must match the recorded commit.
Tests cover both supported architectures for Windows/Linux manifest selection
and a real isolated Windows directory junction, which is rejected. These are
package-validation tests, not a Linux systemd installation acceptance result.

Management builds emit `dist/THIRD_PARTY_NOTICES.json` from dependencies with
rendered code in JavaScript chunks, plus Vite's browser-helper and Tailwind's CSS
generators. It retains original license/notice text, package versions, declared
license metadata and source-file hashes. Missing or empty license text,
lockfile/version mismatch, linked dependencies and non-file notice entries fail
the build. The control bundle inventories this asset with its other files;
browsers do not download it as part of page startup. This is the management
frontend's notice inventory, not the complete native-product SBOM or a completed
license review for all shipped components.

Viewer Webpack builds now emit the same `THIRD_PARTY_NOTICES.json` format using
the shared collector, including concatenated chunk modules and the Webpack
runtime generator. The published `@ubjs/core@0.31.0-6` npm package omits its
license file; `scripts/licenses/ubjs-core-0.31.0-6/` preserves its published
revision's upstream notice and the referenced full MPL-2.0 text. Supplement use
requires exact version, npm lockfile integrity and license-file hashes.
This covers npm JavaScript dependencies, not Rust/WASM, copied project assets
or native gateway dependencies; those remain separate release obligations.

Control revision `8acd3c51` passed a clean Windows bundle build and real Chromium
acceptance at `artifacts/control-bundle/2026-10-31T10-05-19-063Z/`, including
read-only configuration preflight before bootstrap and after configuration save.
Full local control Go tests passed. This does not establish SCM installation.

The control executable's compiled Go dependency metadata drives
`THIRD_PARTY_NOTICES.go.json` in the bundle root. Module versions, local
replacements, vendor license/notice/attribution texts and their hashes are
retained, including nested notices. Go's root license and patents notice are
included from the matching build toolchain. Missing license texts, invalid
module paths and linked or special vendor entries fail packaging. This covers
the control executable's module notices; Sunshine, media gateway and their
native dependencies still require their own package inventories and review.

CI retains structured Orchestrator test events per OS and annotates failing
test/package names without copying test output into annotations. Control-plane
and gateway jobs have independent queues per ref and operating system; management
Web and SBOM jobs each have their own queue. Each queue preserves its running job
and retains the newest pending revision, so a stalled gateway cannot hold up a
new control-plane build. Job timeouts bound failures without cancelling healthy
builds on every push. Bundle build failures retain their compiler/packaging log
and publish bounded diagnostic excerpts. This does not restore cancelled runs
or cancel historical jobs started with the old workflow definition.
Earlier on 2026-10-31,
the Actions API showed run `41147255650` (commit `7dfa293b`) queued without an
assigned runner. The most recent completed run `41117602538` (commit `606a181e`)
failed Windows Orchestrator tests while its other five jobs succeeded. The log
download returned HTTP 403, so the specific historical test failure remains
unidentified; local passing tests do not establish that remote CI is green.

Static page discovery requires a regular `index.html`, and checks the
configuration directory's `dist/`, its development `web/dist/`, then the
executable's sibling `dist/`, in that order. An empty directory or a directory
containing only a compiled executable is not a valid frontend bundle. Existing
configuration-local page overrides keep precedence; update or remove an old
override when upgrading the installed page. Application data paths still resolve
against the configuration directory; this change only affects page discovery.

This artifact is the control-plane bundle, not a signed complete platform
installer. Encoder/gateway packaging, signing and full installation acceptance
remain separate release requirements. Local HTTP tests cover external config
paths, SPA routes, static assets and API-route exclusion; they do not replace a
Windows SCM or Linux systemd installation test.

The Linux unit runs the pinned Orchestrator binary with a dedicated service account and persistent state directories. Install it under `/opt/stream-kit`, copy the unit to `/etc/systemd/system`, create `/etc/stream-kit/orchestrator.json`, then run `systemctl enable --now stream-kit-orchestrator`.

On Windows, run `install-windows-service.ps1` from an elevated PowerShell after placing `orchestrator.exe` in the install root. The service is configured for automatic restart by the Windows Service Control Manager.

The executable detects SCM launch through the vendored `x/sys/windows/svc`
implementation. It reports startup pending until configuration, persistence,
TLS and the HTTP listener are initialized; stop and shutdown requests cancel the
same runtime used by console signal handling. Stop remains pending until HTTP
draining and owned resource cleanup complete. Startup errors return a nonzero
service result without waiting for keyboard input. Pending operations report
checkpoints to SCM. The listener is owned continuously from startup through
shutdown, rather than being probed, closed and reopened.

Runtime shutdown also joins the media-state reconciler, session lease reaper and
encoder monitor before releasing application persistence. Automatic component
startup is joined after cancelling the component manager, so a readiness wait
cannot outlive shutdown or hold it until the normal startup timeout. The shared
goroutine helper exposes completion only after deferred cleanup and panic
reporting finish. Tests include cancellation during an in-flight encoder HTTP
observation, HTTP/HTTPS shutdown and SQLite release; lifecycle and completion
tests pass with the Windows race detector.

Managed component stdout/stderr are drained by `exec.Cmd`'s owned copy workers.
Process completion is published only after those workers finish and final
unterminated lines are retained. A published line retains at most 64 KiB; excess bytes are
discarded until the next newline with an explicit truncation marker, while the
pipe continues to drain. This prevents an oversized diagnostic line from
blocking the child process. A two-second post-exit pipe wait bounds descendants
holding inherited pipe handles. Tests use a real child emitting a 3 MiB line and
final stdout/stderr fragments, plus Windows race checks. This change does not
provide interactive-session launch or validate capture from a Windows service.
Each component's log history also has a 4 MiB text budget in addition to its
configured line count. Oldest entries are evicted and their references cleared
when either limit is reached. Subscriber lines share the same length bound;
subscriber queues and other runtime allocations are separate from this budget.

The Windows installer requires an existing configuration and management page,
rejects an existing same-named service with different launch paths, and configures
failure recovery delays of 5, 15 and 60 seconds. It does not silently migrate an
existing installation. Recovery includes nonzero service-specific exits.

Validation on 2026-10-31 includes simulated SCM start/stop/shutdown/interrogate
and failure transitions, plus actual HTTP and certificate-verified HTTPS runtime
startup, health requests, cancellation, listener closure and SQLite release.
Go tests and Windows lifecycle race tests passed, and Windows/Linux amd64 builds
passed. The first local race-test link attempt failed because the UCRT toolchain
directory was absent from PATH; using the existing UCRT toolchain environment
resolved it. No service was installed, restarted or removed for these checks.
Actual SCM/systemd installation remains unverified. On Windows, running the
control plane as a service does not prove that render processes in session 0 can
capture an interactive user's desktop; interactive rendering deployment still
requires separate verification and appropriate process-session ownership.

Direct managed Sunshine launches now reject Windows Session 0 before executing
native preflight or stopping an existing process for restart. Failure to query
the current session also rejects the launch. The headless gateway and externally
managed Sunshine remain available to the service control plane. Nonzero session
IDs pass this prerequisite only; they are not proof of an unlocked desktop or
working capture.

Managed Sunshine and the media gateway can select the same native Windows
user-session worker through `components.sunshine.windows_session_id` /
`windows_user_sid` and `components.web_server.windows_session_id` /
`windows_user_sid`, respectively. Set both fields for an
active logged-on user; set the ID to `0` and clear the SID to retain direct
launch. The management configuration page exposes both fields and marks them
as requiring a control-service restart. They are rejected for other components,
external-monitor mode, system service accounts, or Linux deployments.

For local microphone delivery, explicitly place the gateway in the same user
session as the target application so its native audio endpoint operations run
in that user's audio context. A headless gateway may retain direct launch when
it does not need user-session audio devices. This selection reuses the worker's
preflight, authenticated pipes, process ownership, session revalidation and
shutdown; it does not install virtual audio devices or establish that target
recording works. Session changes still require a control-service restart.

The control service must run as LocalSystem to acquire the selected user's WTS
token. The user identity and session are checked before native launch; there is
no fallback to another desktop. The worker uses `winsta0\default`, a contained
process tree, mutually authenticated local pipes, and an immutable per-launch
snapshot. Native preflight runs in that same user context before an existing
renderer is stopped. Logs, heartbeats, stop, kill and exit ownership use the
same component manager as direct processes. The controller revalidates the
selected active session and SID immediately and on each 10-second heartbeat.
Loss or mismatch terminates the owned job and records the reason in component
logs. It never moves the renderer into another session automatically; a later
restart must pass the same user/session checks. Recovery across actual Windows
logon/session changes remains unaccepted until the SCM test is performed.

The launch transaction, failure cleanup, preflight failure, process lifecycle
and 35-second idle heartbeat have native tests, including a built worker binary.
Cross-session LocalSystem/SCM acceptance remains outstanding: the development
shell used for these checks is not elevated. These tests do not establish that
an installed service can capture or inject audio in the selected desktop.

TLS termination should be provided by the deployment ingress; the Orchestrator bind address must remain private when TLS is terminated outside the process.
