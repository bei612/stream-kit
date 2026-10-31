# Control service bundle

This package contains the Orchestrator, management Web assets, dependency
notices, integrity manifest and the service definition for its target OS.
It does not contain Sunshine, the media gateway or audio drivers. Configure
separately built matching media components before streaming acceptance.

Keep the bundle immutable, with configuration, credentials, logs, uploads and
the database outside it. Do not add configuration files to the bundle directory.
`verify-bundle` checks the complete file inventory and target platform; it does
not verify publisher identity or replace a signed distribution channel.

## Prepare configuration

Run `orchestrator init-config --config PATH` with an absolute path outside the
bundle. This initializes configuration without starting listeners or components
and refuses to overwrite an existing file. Normal startup with an absent file
also generates configuration and exits for review. Empty or default `admin`
passwords and empty JWT keys in an adjacent `config.example.json` are replaced
with random values; explicitly configured non-default credentials are preserved.
The repository sample leaves media executable paths unset until the matching
bundles are selected. Protect the generated file with permissions limited to the service
identity and administrators. Review paths, credentials, bind address, TLS and
media settings before starting the service; do not copy secrets into logs.

Run `orchestrator check-config --config PATH` (use `orchestrator.exe` on Windows)
in the intended service identity and environment. It validates configuration and
any configured TLS key pair without starting services or creating runtime data.
It does not prove ports are available or media components work. When using a TLS
ingress, keep the control listener private and configure the public media URL
with the browser-accessible HTTPS address.

## Windows

Place the complete bundle at `C:\Program Files\StreamKit` and configuration at
`C:\ProgramData\StreamKit\orchestrator.json`, or supply explicit paths:

```powershell
.\orchestrator.exe service install --config 'C:\ProgramData\StreamKit\orchestrator.json'
.\orchestrator.exe service start --config 'C:\ProgramData\StreamKit\orchestrator.json'
```

Service registration requires an elevated terminal or installer. No PowerShell
script execution-policy change is required. The native executable checks
bundle integrity and configuration before registering/starting the service and
refuses to replace an existing service that uses different paths. Preflight
runs as the invoking account; the service runs as LocalSystem and does not
inherit that shell's environment. Store the intended deployment configuration
in the protected file and verify service startup under its actual identity.

`service stop --config PATH` performs a graceful stop with a bounded wait;
`service remove --config PATH` stops and unregisters this installation without
deleting configuration or application data. All operations reject a service with
a different executable/configuration command, account or service type. Install
does not start the service; start returns success only after SCM reports Running.
The PowerShell entry point remains a compatibility wrapper around these commands.

Rendering and audio require the intended logged-in interactive user's session.
Configure the media components' Windows session ID and user SID together in the
management page before enabling automatic launch. Installing the control service
alone does not establish desktop capture, target microphone routing or drivers.

## Linux

Place the complete bundle at `/opt/stream-kit/orchestrator`. Prepare the
`streamkit` service account and `/etc/stream-kit/orchestrator.json`. Configure
absolute writable storage/log paths under `/var/lib/stream-kit` and
`/var/log/stream-kit`, create those directories, and grant that service identity
the required access. Keep the package directory read-only to the service.

The included `stream-kit-orchestrator.service` uses those paths and account.
Install the unit into `/etc/systemd/system/`, then reload systemd and enable/start
`stream-kit-orchestrator.service` using the deployment administrator. The unit
checks bundle integrity and configuration on each start. Customize an installed
unit or systemd override for nonstandard paths, leaving the packaged copy intact.
The control service's filesystem sandbox does not provide access to a graphical
session or PulseAudio/PipeWire; verify the selected media process environment
and native devices separately before accepting streaming.

## Updates and recovery

Keep the prior verified bundle and back up configuration/database before an
update. Stop the control service before replacing its complete bundle; never
merge new files into a live package. Verify the replacement and start it, then
check login, media components and client recovery. Database/schema rollback
compatibility must be checked for the particular release; automatic rollback is
not provided by this package. Do not restore a live database by copying over it.
