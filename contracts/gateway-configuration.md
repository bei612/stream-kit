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

TLS preflight, configuration save and startup share the same bounded PEM
loader. Each certificate/key file must be readable, regular and at most 1 MiB.
The native TLS library checks PEM parsing, certificate/key usability and their
correspondence before saving or allocating startup resources. Errors omit file
paths and contents. Relative TLS paths retain the native working-directory
semantics; they are not relative to the configuration file.

The command does not start listeners, execute ICE scripts, create runtime
storage or open audio devices. Passing does not prove certificate expiry,
hostname or public trust, future file availability, device availability,
network reachability or end-to-end media operation. Native configuration
changes still require a gateway restart. External file changes after validation
are checked again at startup; save does not install or rotate certificates.

Normal gateway startup uses the same validation before creating application
resources. A startup error returns exit 1 so the service manager can distinguish
failure from a normal shutdown. Existing configurations containing unsupported
fields need correction before upgrading; diagnostic commands do not rewrite
the source file.

`scripts/test-gateway-config.cjs <binary>` exercises the real executable,
including overridden values, missing files, failure exit status and absence of
storage side effects. It is included in the Windows/Linux build workflow.
The unified management UI remains separate integration work; this preflight
alone is not that integration.

## Signed native configuration API v1

`POST /internal/v1/configuration` (under the configured gateway URL prefix)
accepts a bounded JSON request with `schema_version: 1`, a 32-character hex
`request_id`, `issued_at_ms`, and `operation` (`read` or `save`). Save also
requires `revision` and a `changes` object mapping existing JSON Pointer paths
to replacement values. Read cannot carry revision or changes. Overlapping
parent/child edits, unknown paths, more than 256 edits and invalid typed results
are rejected. Optional objects can be replaced as a whole at their existing
path; array members use JSON Pointer indices.

`x-stream-control-signature` is HMAC-SHA256 hex over the request domain
`stream-kit/gateway-configuration/request/v1\n` followed by the exact body.
The key is the running gateway's media trust secret. Timestamps may be at most
5 seconds old or 2 seconds in the future. Other signature purposes and browser
credentials do not authorize configuration access.

Successful domain processing returns an envelope containing `schema_version`,
`request_id`, `request_issued_at_ms`, and `result`. Both success and domain-error
envelopes use the response domain
`stream-kit/gateway-configuration/response/v1\n`. The caller must verify the
signature and request binding before trusting values or errors. Authentication,
malformed input and resource admission failures can return unsigned rejection;
these responses must never be interpreted as configuration snapshots.

The result's data contains `revision`, `running_revision`, `restart_required`,
`apply_policy: gateway_restart`, `values`, `redacted_paths`, and
`overridden_paths`. Trust secrets, TLS material, ICE script and ICE credentials
or URLs are redacted to null and identified explicitly. Omitted changes retain
their original values; null is an explicit replacement, not a retain marker.
Overrides are captured from the running gateway's CLI/environment. Their values
are never persisted by configuration editing.

`revision` hashes the current saved file bytes. `running_revision` is the hash
of the source file actually read by this process at startup, or null when startup
used defaults without a source file. Saves never change the running revision.
The administrator client validates a supplied running hash and its consistency
with `restart_required`; an older gateway without this field supplies no explicit
running-version evidence. File-version equality does not override deployment
arguments/environment, prove media operation, or prove certificate-file contents
are unchanged. Deploy the matching control-plane binary before the gateway;
older strict response decoders may reject this new response field.

Save checks the raw file revision, derives and validates the effective native
configuration, writes and syncs a new same-directory file, and replaces the
source. Unix also syncs the directory and creates the file with mode 0600.
The configured source must be an existing regular file of at most 1 MiB, not a
symlink. Human-JSON comments and formatting are normalized on save. Operations
are serialized and bounded in-process. External changes already present before
replacement are detected, but this is not a cross-process editor transaction.
A post-replacement durability error may require re-reading to learn whether the
file changed.

Conflicts return HTTP 409 / `CONFIGURATION_CONFLICT`, invalid changes HTTP 400 /
`CONFIGURATION_INVALID`, unavailable files HTTP 503 /
`CONFIGURATION_UNAVAILABLE`. All responses disable caching. No save mutates
runtime configuration or restarts a service. Changes to trust, listeners or
control-plane addressing need coordinated deployment before restart.

## Unified administrator API

The Orchestrator exposes authenticated `GET /api/v1/gateway-configuration` and
`PATCH /api/v1/gateway-configuration`. PATCH accepts only `revision` and
`changes`, with a 256 KiB body limit. The existing single-administrator
authentication applies to both routes. The publisher signs native requests and
verifies the response signature, protocol version, request ID, timestamp and
error/status mapping before returning the redacted view. Native fields remain
owned and validated by the gateway; no duplicate Go configuration schema is
introduced. Device inventory and configuration reuse the same signature helper
with separate protocol domains.

These requests do not acquire the media-state publisher lock or delay its lease
renewal. The native gateway admits one configuration operation at a time, with
the permit retained by its blocking file task even if HTTP is cancelled.
Unsigned or mismatched native responses become a generic unavailable error;
untrusted diagnostic text is never forwarded to the administrator.

The settings page includes the native gateway editor with grouped controls,
redacted-value preservation, deployment override and pending-restart indicators.
Simple fields and existing list entries are edited individually. Port ranges,
NAT mappings, TLS paths and forwarded-header settings have dedicated optional
object controls. Existing objects submit only edited children; enabling a new
object submits its complete value, and disabling submits null. Undo restores
the loaded object and clears its child drafts. TLS paths remain individually
editable even though their original values are redacted. Complete collection
replacement is explicit and starts empty, so the user must supply every desired
entry and credential instead of accidentally resubmitting redacted placeholders.
Drafts survive failed saves; per-field undo and reload discard them explicitly.
Coordinated component restart remains outstanding.

## Managed component preflight

The component supervisor accepts `components.<name>.preflight_args`. When set,
it executes that component's own executable with these arguments, using the
same working directory and environment, with a 15-second timeout and no shell.
The gateway example uses `config check`; installations using a custom config
path or CLI overrides must include those same options in the preflight command.
Arguments are redacted in configuration responses and editable in the unified
settings page. Changing this supervisor setting requires Orchestrator restart.

Start and automatic recovery must pass preflight before launch. Restart first
checks before stopping the current process, so a failed check preserves it and
its health monitor. The launch path checks again after stop to catch file changes
during shutdown. A failure at that point leaves the component stopped with an
error; this is not rollback or an atomic deployment transaction. Successful
launch still requires health checks and gateway revision verification before
claiming configuration activation. Component operation failures appear inline
in the management page and do not turn a preflight failure into a stopped state.

`--edit-gateway-configuration` on the source-stream acceptance runner logs into
the production administrator page and edits through its form while video and
audio are active, then checks the API result, pending restart and stale-version
rejection. The management and gateway assets use separate directories and their
hashes are captured with the result.
