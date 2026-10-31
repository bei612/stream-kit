# Windows unified setup

The first-install wizard and silent mode use the same native `init-platform` and
`service` commands. Setup elevates once. It does not change PowerShell execution
policy or firewall policy and never reboots the machine automatically. An
authorized build can include the reviewed VB-CABLE package inside the same EXE;
otherwise an existing compatible virtual endpoint can be selected later.

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

## Bundled virtual audio driver

The builder accepts `--audio-driver PACKAGE_DIRECTORY
--audio-driver-authorization PRIVATE_RECORD_JSON` after its three existing
arguments. Both options are required together. The input must be the complete,
unmodified official VB-CABLE Pack45 directory. All 31 files are checked against
`third_party-manifests/windows-audio-driver.json` and the vendor installer's
Authenticode publisher is checked before inclusion. The payload is embedded in
the one platform installer; there is no online download or extra UAC request.

The private authorization record contains `vendor: "VB-Audio"`,
`product: "VB-CABLE"`, `scope: "professional-bundle"`, and a nonempty `reference`
to the actual vendor authorization/order. It is supplied by the distributor;
the build checks the record's structure, not the legal validity of the grant.
Only its SHA-256 is published; customer and invoice contents are not bundled.
No such authorization has been supplied for the currently published candidate,
which continues to exclude this driver.

During installation a healthy existing VB-CABLE PnP device is reused. An
existing but unusable registration is reported instead of overwritten. A fresh
installation invokes the vendor's `-i -h` mode under the already elevated setup
process, checks its exit status and driver registration, and returns `3010`
after platform service registration to request a manual restart. Startup is
deferred in that case; after restarting and logging into the configured desktop
account, check the components and audio endpoints from the management page.
Do not treat `3010` as full streaming acceptance. Without a fresh driver the
existing normal component-readiness gate still applies.

VB-CABLE is by VB-Audio (https://vb-audio.com/Cable/), distributed under its
donationware/licensing terms (https://vb-audio.com/Services/licensing.htm).
The platform uninstaller retains the shared system audio driver. Setup does
not set default audio endpoints; Windows may automatically select a newly
installed device, as described in the vendor manual. This adapter's first-time
driver installation and reboot flow still require real installation acceptance.

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
The installer also requires the matching Windows example bundle, including both
`checkerboard.exe` and its native `audio-probe.exe` helper. Build it with
`node scripts/build-example-release.mjs NEW_EXAMPLE_DIRECTORY`, then provide that
bundle as the fourth component before the output argument to
`scripts/package-platform-release.mjs`. A Start menu entry opens the example;
it is not launched automatically during installation. This keeps the complete
audio/video test application in the same installer and source inventory.
The example and gateway share the Cargo notice collector; generated notices
record dependency identity, license text hashes and missing-text packages.
No additional runtime monitoring service or dependency is introduced.
The builder verifies payload hashes and records the resulting installer hash,
compiler hash and source revision. The executable is currently unsigned and the
channel remains preview. Publisher code signing is not required by the current
delivery scope; the absence of a commercial signing certificate is not a release
blocker. Compilation/unit tests are not installation acceptance;
real elevated installation, streaming under SCM, and uninstall still require
validation before publishing an installer for production deployment.
