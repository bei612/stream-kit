# Managed renderer bundle

This directory is staged from the source-built Sunshine renderer using its
configured CMake installation rules. It includes the executable, runtime libraries,
shaders, renderer Web assets and native tools. No driver, firewall rule or
Windows service is installed by the staging command.

Use the Orchestrator's `sunshine` component to manage this executable. Set its
working directory to this bundle, and pass an absolute external Sunshine
configuration path as its argument. Keep the apps catalog, credentials, keys,
certificates, pairing state and logs outside the release directory, with explicit
paths in the Sunshine configuration. Configure the interactive Windows session
through the Orchestrator before enabling automatic startup under its service.

The upstream service installation scripts are included by CMake for completeness;
the unified platform uses the Orchestrator supervisor. Do not register a second
Sunshine service for the same renderer.

Deployment automation can invoke `sunshine.exe ABSOLUTE_CONFIG --creds-stdin`
and pipe a JSON object with `name` and `password` fields, closing stdin afterward.
This uses Sunshine's native credential format without putting the password in
process arguments. Prepare the protected credentials directory first. Names
must contain 1–128 UTF-8 bytes and passwords 12–1024 bytes; input is limited to
16 KiB. The operation sets credentials (including replacing an existing valid
credential file), so use it only for initial setup or an intentional reset.
Both this command and the legacy `--creds` command return failure if persistence
fails. Neither starts a streaming listener. Configuration and logs must remain
outside the immutable bundle for these commands as well as normal startup.

Build and stage from a clean committed checkout:

```
node scripts/verify-sunshine-release.mjs BUILD_DIRECTORY FULL_COMMIT --output NEW_DIRECTORY
```

The build must report the same commit. Windows uses the relative `assets`
directory. For a Linux unified platform bundle, build using
`SUNSHINE_PACKAGE_LAYOUT=platform SUNSHINE_REQUIRE_CLEAN=1` with
`scripts/build-sunshine.sh`. The shared layout catalog supplies its native
`bin/sunshine` and `share/sunshine` resource paths. The Linux stager uses CMake's
`DESTDIR` installation, retains native bin/lib/share and ELF RPATH, verifies the
installed source stamp and dependency resolution, and checks that Vulkan resolves
to the private source-built loader. It does not install standalone service units
or udev rules onto the build host. Relative resources and OpenGL shaders resolve
from the executable directory; absolute native package paths retain their meaning.

The manifest inventories regular files by SHA-256; it is not a publisher
signature or complete third-party license clearance. Keep the old release for
rollback and switch the executable and working directory together while stopped.
Ordinary Linux distribution packages can still use the default native CPack
profile. The unified platform profile preserves its own native Linux layout
rather than flattening an installed ELF tree into the Windows layout.
