# Stream-Kit service deployment

The Orchestrator CI artifact contains the executable and a sibling `dist/`
directory with the unified management page. Keep this layout when installing:
on Linux, both belong under `/opt/stream-kit/orchestrator/`; on Windows, both
belong under the install root passed to the service installer. Configuration can
remain in `/etc/stream-kit/` or `C:\ProgramData\StreamKit\` independently.

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
Hashes identify the packaged bytes; the manifest is not a signature, SBOM or
proof that the complete platform has passed acceptance.

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

Management builds emit `dist/THIRD_PARTY_NOTICES.json` from dependencies with
rendered code in JavaScript chunks, plus Vite's browser-helper and Tailwind's CSS
generators. It retains original license/notice text, package versions, declared
license metadata and source-file hashes. Missing or empty license text,
lockfile/version mismatch, linked dependencies and non-file notice entries fail
the build. The control bundle inventories this asset with its other files;
browsers do not download it as part of page startup. This is the management
frontend's notice inventory, not the complete native-product SBOM or a completed
license review for all shipped components.

The control executable's compiled Go dependency metadata drives
`THIRD_PARTY_NOTICES.go.json` in the bundle root. Module versions, local
replacements, vendor license/notice/attribution texts and their hashes are
retained, including nested notices. Go's root license and patents notice are
included from the matching build toolchain. Missing license texts, invalid
module paths and linked or special vendor entries fail packaging. This covers
the control executable's module notices; Sunshine, media gateway and their
native dependencies still require their own package inventories and review.

CI retains structured Orchestrator test events per OS and annotates failing
test/package names without copying test output into annotations. The workflow
cancels superseded runs in the same ref's concurrency group; this does not
retroactively put older workflow versions into that group. On 2026-10-31,
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

Managed Sunshine can now select the native Windows user-session worker through
`components.sunshine.windows_session_id` and `windows_user_sid`. Set both for an
active logged-on user; set the ID to `0` and clear the SID to retain direct
launch. The management configuration page exposes both fields and marks them
as requiring a control-service restart. They are rejected for other components,
external-monitor mode, system service accounts, or Linux deployments.

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
