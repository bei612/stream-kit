Stream-Kit provides one native installer per supported server platform: Windows x64 and Ubuntu 24.04 amd64. Each package contains the single-administrator control service and management UI, Sunshine renderer, and Web/PWA media gateway from one source revision.

Windows supports `/VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART`; Windows UAC remains applicable. On Ubuntu use `sudo bash INSTALLER.run --user RENDER_USER`. Installation and runtime do not require Node.js/npm or compiler toolchains. Development examples, UE SDK probes, Playwright and acceptance fixtures are excluded.

Both installer manifests, SHA-256 checksums and the source SBOM accompany the downloads. Verify the checksum before installation. Windows product builds include the open-source virtual-audio controller and shared Audio class identity, recorded in the installer manifest. Select the resulting input in the target recording application. Remote browser microphone access requires trusted HTTPS and client permission.

See `deploy/PLATFORM.md`, `deploy/windows/README.md` and `deploy/linux/README.md` in the source archive for initialization, protected credentials, runtime dependencies and data retention. Publisher code signing is outside this delivery scope. Product version selection does not replace deployment acceptance; a stable release is published only after the applicable delivery checks have been completed.
