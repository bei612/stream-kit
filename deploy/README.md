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

TLS termination should be provided by the deployment ingress; the Orchestrator bind address must remain private when TLS is terminated outside the process.
