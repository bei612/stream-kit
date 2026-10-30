# Gateway configuration preflight

The gateway owns its native configuration types and validation rules. Both
`App::new` and the `config check` command use `Config::validate` before creating
storage or media resources. The control plane must use this native validation
boundary when native configuration editing is integrated; it must not maintain
a second, divergent copy of the Rust rules.

```text
web-server --config-path <existing-file> config check
```

The command reads the existing human-JSON configuration, applies the gateway's
normal command-line and environment overrides, and validates the resulting
configuration. Exit 0 means these structural and semantic checks passed. Exit 2
means the requested file is missing, parsing failed or validation rejected the
configuration. Successful output contains no configuration values. Parse errors
report line and column instead of echoing potentially sensitive values.

Checks include native configuration field names/types, managed trust settings,
audio-route ownership, positive storage cleanup and session-cookie durations,
ordered nonzero WebRTC port bounds, explicit NAT IP addresses, native host port
and forwarded username header syntax. Unknown fields in the native configuration
objects are rejected rather than silently ignoring an administrator's edit.

The command does not start listeners, execute ICE scripts, create runtime
storage or open audio devices. Passing does not prove certificate validity,
path permissions, device availability, network reachability or end-to-end media
operation. Native configuration changes still require a gateway restart.

Normal gateway startup uses the same validation before creating application
resources. A startup error returns exit 1 so the service manager can distinguish
failure from a normal shutdown. Existing configurations containing unsupported
fields need correction before upgrading; diagnostic commands do not rewrite
the source file.

`scripts/test-gateway-config.cjs <binary>` exercises the real executable,
including overridden values, missing files, failure exit status and absence of
storage side effects. It is included in the Windows/Linux build workflow.
The unified management UI and versioned native-file save operation are still
separate implementation work; this preflight alone is not that integration.
