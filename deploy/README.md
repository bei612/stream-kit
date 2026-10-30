# Stream-Kit service deployment

The Orchestrator CI artifact contains the executable and a sibling `dist/`
directory with the unified management page. Keep this layout when installing:
on Linux, both belong under `/opt/stream-kit/orchestrator/`; on Windows, both
belong under the install root passed to the service installer. Configuration can
remain in `/etc/stream-kit/` or `C:\ProgramData\StreamKit\` independently.

After building `orchestrator/web`, use `node scripts/build-control-plane.mjs`
from the repository root to build the control-plane bundle. `--go` selects the
Go executable and `--output` selects a new output directory. Existing output is
never overwritten. CI uses `--require-clean`, Go 1.25.0 and Node 26.4.0; a dirty
source tree is rejected before creating a release output. Local builds without
that flag are explicitly marked `-dirty` when appropriate.

The executable reports its source commit and version. The embedded build stamp
is the source commit timestamp for reproducibility, not wall-clock packaging
time. `bundle-manifest.json` records the commit, dirty state, target, Go version,
and SHA-256/size of every executable and page asset. The page must be rebuilt
from the same source first; CI does this before invoking the bundle script.
Hashes identify the packaged bytes; the manifest is not a signature, SBOM or
proof that the complete platform has passed acceptance.

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

TLS termination should be provided by the deployment ingress; the Orchestrator bind address must remain private when TLS is terminated outside the process.
