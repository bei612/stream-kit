# Managed Web and Android connection lifecycle

The control plane owns connection identity, leases and controller authority.
The gateway consumes only active connections through the signed media-state
projection. Dormant recovery records are never media authority or public state.

## Expiry and recovery

An active lease lasts 15 seconds and the browser renews it every 5 seconds.
Expiry removes the active connection and releases its controller authority.
The existing SQLite session record retains a private recovery entry for at most
15 minutes after lease expiry, with at most 128 entries per rendering session.
Eviction removes the oldest entry. This retains no media or audio resources.

`POST /api/v1/client-sessions/{session}/connections/{connection}/resume`
requires the original, unexpired connection-purpose bearer credential. Its
session, connection and subject must match the retained record. Administrator,
invitation and media-ticket credentials cannot substitute for this credential.
The original token expiry remains a hard recovery limit, even if a dormant
record is still retained.

Successful recovery returns the normal connection snapshot and renewed
connection token. It preserves the connection ID, consumes normal viewer
capacity and restores an expired peer as a viewer with microphone activity
cleared. It never restores expired controller authority. Repeating recovery for
an already active peer is idempotent with respect to membership; a later
administrator control assignment is not undone by a retried response.

The HTTP error envelope has top-level `status`, `code`, `message` and
`request_id` fields. Clients classify the structured code, not message text.

| Response | Meaning and client action |
| --- | --- |
| 401 `CONNECTION_UNAUTHORIZED` | The connection credential is invalid. End the owning connection for its current operation/credential; a stale response for a superseded credential/operation cannot end its replacement. |
| 410 `CONNECTION_LEASE_EXPIRED` | The live lease expired but matching recovery authority remains. Disable authority and recover the same connection through `resume`. |
| 410 `CONNECTION_TERMINATED` | The session/connection is missing, stopping, stopped or explicitly revoked, or recovery authority no longer exists. End locally; do not resume or create a fresh admission automatically. |
| 409 | Capacity/state conflict; do not claim successful recovery. |
| 503 or network failure | Keep authority disabled and use the existing bounded requests and low-frequency recovery loop. |

For compatibility, older servers' ambiguous 410 `CONNECTION_EXPIRED` permits
recovery of the same identity. A definitive resume 401/410 ends that attempt;
other 410 responses are terminal. No new global recovery-duration limit is
introduced. Persistence failures do not publish a changed live snapshot.

The browser disables microphone capture before recovery, then requests a fresh
media ticket. The heartbeat owns recovery; concurrent transport ticket failures
must not discard the identity it needs. Transient failures retry through the
existing heartbeat and transport loops. Terminal 401/410 recovery failures
require an explicit new viewing action using a valid permanent link; ending a
connection does not rotate that link. No invitation is retained in the URL or
storage.

## Authority snapshots and microphone recovery

Join, heartbeat and resume return the same connection authority snapshot,
including `revision` and `control_epoch`. The browser requires nonnegative safe
integers for both versions, a connection identity and credential, a viewer or
controller role, and a boolean microphone policy. Invalid snapshots cannot
replace credentials or authorize capture. A delayed lower revision is ignored;
a newer snapshot cannot decrease the control epoch. Resume requests a media
ticket only after accepting the connection snapshot.

Media transport replacement releases physical capture immediately. It may keep
the intent of an already live microphone only for the same session, connection
and control epoch. The replacement pipeline refreshes authority before opening
capture again. Revocation, epoch change, failed authorization or explicit stop
clears that intent. A peer that never enabled capture cannot start it through
reconnection. Expired controller leases still resume as viewers.

Deploy the control plane exposing `control_epoch` together with this browser
bundle; missing version fields are protocol failures, not a legacy fallback.
The real Go handlers and SQLite persistence regression distinguish expired
leases, explicit revocation and terminal sessions, including after storage
reload. The server resume test checks both versions against the authoritative
session snapshot. Historical `test-media-access.mjs` and
`test-stream-pipelines.mjs` use replaced objects and are archived fixtures,
not current deployment acceptance. The installed `playwright-cli` workflow
checks actual decoded frames, authority transfer, terminal viewer state and
closed RTC; source or compilation alone is not a passing run.

Windows validation on 2026-10-31: 40 browser lifecycle/audio tests and the Go
handler suite passed. The production Web build passed with existing bundle-size
warnings. Real two-browser encoder replacement passed in
`artifacts/source-stream/2026-10-30T23-27-46-308Z/browser/result.json`:
25,091ms recovery, microphone broadcast approximately -40.68dB, viewer capture
denied, subsequent authority checks and owned-process cleanup passed. This used
synthetic microphone audio. The final additional string-type checks for identity
and credentials were verified by unit tests and production build after this run;
they were not part of that browser artifact.

## Explicit removal and stopping

Authenticated `DELETE` of a connection also accepts its dormant record, so a
user stopping during an outage can revoke recovery authority. Other ordinary
connection commands require an active lease. Administrator removal erases both
active and dormant membership. Stopping or stopping-completed session states
clear all recovery records. These operations and recovery share the session
domain's serialized, persist-before-publish transaction boundary.

Web and Android retain the originating connection identity for asynchronous
operations. Late responses cannot restore authority, credentials or recording
after stop, or mutate a later start. Normal Web close joins one stop operation,
deletes its WHEP resource before leaving the connection, and releases input,
microphone and RTC. Once termination is known, close is local and does not send
invalid remote cleanup or restart recovery. A failed network request cannot
guarantee immediate server cleanup; lease expiry still bounds active membership.
Recovery does not bypass explicit server-side removal.

## Compatibility and evidence

Deploy the control-plane recovery endpoint before or together with the updated
browser bundle. The media-state wire format is unchanged. SQLite migration adds
the private recovery column; older sessions begin with no retained authority.

`scripts/accept-source-stream.cjs --expire-client-lease` blocks one browser's
HTTP access to the control plane until its lease disappears, verifies control
revocation, restores HTTP and requires new decoded frames without page reload.
It also checks the same connection ID returns as a viewer. This scenario is
not a system network, UDP outage, WAN, or physical microphone acceptance test.
