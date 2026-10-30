# Stream-Kit service deployment

The Orchestrator CI artifact contains the executable and a sibling `dist/`
directory with the unified management page. Keep this layout when installing:
on Linux, both belong under `/opt/stream-kit/orchestrator/`; on Windows, both
belong under the install root passed to the service installer. Configuration can
remain in `/etc/stream-kit/` or `C:\ProgramData\StreamKit\` independently.

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
