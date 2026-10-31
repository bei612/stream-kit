# Windows unified setup

The first-install wizard and silent mode use the same native `init-platform` and
`service` commands. Setup elevates once. It does not change PowerShell execution
policy, audio defaults, firewall policy or reboot the machine. The audio driver
is not bundled; an existing compatible virtual endpoint can be selected later.

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

Use the official Inno Setup 7.1.1 distribution. Its license and commercial-use
information are available at https://jrsoftware.org/isorder.php and in the
compiler distribution; no compiler binary is vendored in this repository.

```text
node scripts/build-windows-installer.mjs PLATFORM_BUNDLE NEW_OUTPUT OFFICIAL_ISCC_EXE
```

The platform must be assembled from clean, matching source-built components at
the current commit. The control manifest must declare initialization version 1.
The builder verifies payload hashes and records the resulting installer hash,
compiler hash and source revision. The executable is currently unsigned and the
channel remains preview. Compilation/unit tests are not installation acceptance;
real elevated installation, streaming under SCM, and uninstall still require
validation before publishing an installer for production deployment.
