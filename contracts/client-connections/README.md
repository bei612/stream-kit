# Managed Web and Android connection lifecycle

The control plane owns connection identity, leases and controller authority. The gateway consumes active connections through the signed media-state projection. Private recovery records are never online membership, media authority or public device accounts. Current runtime evidence belongs in [release status](../../docs/release-status.md).

## Expiry and recovery

An active lease lasts 15 seconds; the client renews every 5 seconds. Expiry removes active membership and controller authority. SQLite retains a private recovery entry for at most 15 minutes after expiry and at most 128 entries per rendering session, evicting oldest first. It retains no media/audio resources. The original token expiry is still a hard limit.

`POST /api/v1/client-sessions/{session}/connections/{connection}/resume` requires the original unexpired connection-purpose bearer, matching session, connection and subject. Administrator, invitation and media-ticket credentials cannot substitute.

Recovery preserves connection ID, consumes viewer capacity and returns normal authority plus a renewed connection credential. An expired peer returns as viewer with microphone activity cleared. Repeating resume for an already active peer is membership-idempotent; a retried response must not undo a newer administrator assignment.

## Structured errors

The error envelope uses top-level `status`, `code`, `message`, `request_id`. Classify code, not translated message text.

| Response | Owning client action |
| --- | --- |
| 401 `CONNECTION_UNAUTHORIZED` | End the current owning credential/operation; a stale response cannot end a replacement |
| 410 `CONNECTION_LEASE_EXPIRED` | Disable input/recording; recover the same eligible connection |
| 410 `CONNECTION_TERMINATED` | End locally, close RTC and recording, stop automatic recovery/readmission |
| 409 | Capacity/state conflict; do not report recovery success |
| 503 / network failure | Authority remains disabled; use bounded requests and existing low-frequency recovery |

Legacy `CONNECTION_EXPIRED` may attempt same-identity resume. Definitive resume 401/410 ends that attempt; other terminal 410 responses do not trigger fresh admission. A user may explicitly open a valid permanent link again. Termination does not rotate that permanent capability.

## Authority snapshots

Join, heartbeat and resume return the same authority shape, including `revision` and `control_epoch`. Browser validation requires nonnegative safe-integer versions, connection identity/credential, a known viewer/controller role and boolean microphone policy. Invalid snapshots never replace credentials or authorize capture.

Lower revisions are ignored and a newer snapshot cannot decrease the control epoch. Resume requests a media ticket only after accepting the current authority snapshot. Media-ticket role is not an alternative authority source.

## Transport repair versus lease recovery

Media-peer replacement releases physical capture immediately. The Web client may preserve the intent of an already active microphone **only** for the same session, connection and control epoch. Before reopening capture the replacement pipeline refreshes authoritative permissions. Revoke, epoch change, failed authorization and explicit stop clear intent. A client that never enabled capture cannot start it through repair.

This narrow Web transport repair differs from lease recovery: an expired controller resumes as viewer and must receive control and explicitly enable capture again. Android additionally follows native foreground/audio-focus and consent invalidation rules in its [client contract](../android-client.md). Do not document every short media-peer replacement as a new identity, or every reconnect as permission to silently record.

## Media HTTP ownership and logs

The Web client fully reads a successful WHEP OPTIONS response before returning headers. Metadata keeps the existing API timeout; the longer stream-offer startup does not inherit that timeout. The error factory alone reads rejected offer bodies and the offer owner alone reads a successful SDP answer. Body failures retain status for authorization/conflict handling.

Gateway/Web logs use fixed stages rather than SDP, ICE candidates or parser payloads. Parser failures retain the proper static HTTP error category without raw negotiation text. ICE-script failure logs retain status or parser category/location, not command paths, output or credentials. This is logging discipline, not a change to transport authentication.

## Removal, stop and async ownership

Authenticated connection DELETE also accepts its dormant record so stopping during an outage can revoke recovery authority. Other ordinary connection commands require an active lease. Administrator removal erases active and dormant membership; stopping/stopped sessions clear recovery records.

Recovery, removal and state change share the serialized persist-before-publish boundary. Persistence failure does not announce a changed snapshot.

Web/Android retain originating session and operation ownership. Late responses cannot restore credentials/capture after stop or mutate a later start. Ordinary Web close joins a single stop operation, deletes its WHEP resource before leaving membership, releases held input and microphone and closes RTC. Once definite termination is known, cleanup is local; it does not send invalid remote requests or restart admission.

A failed leave request cannot guarantee immediate server cleanup; lease expiry bounds remaining membership. Recovery cannot bypass explicit removal.

## History and compatibility

Render sessions are execution generations, not clients. Stopped histories are read-only and pruned to at most 100 entries and 7 days; permanent application capabilities have a separate lifecycle. Returning next week normally creates a new connection.

Deploy compatible control and viewer resources together. The browser requires revision/control_epoch; missing fields are protocol failures, not an authorization fallback. SQLite recovery-column migration does not create old recovery authority.

## Validation

Use real Go handlers/SQLite and native clients to verify expiry versus explicit removal, post-reload classification, stale responses, input/recording release and exact terminal behavior. Historical VM/replaced-media fixtures are not deployment evidence.

Actual playwright-cli checks must operate produced/deployed assets, decode advancing frames, transfer/revoke authority, stop the application, confirm closed RTC and no later automatic readmission. Classify an aborted management GET as superseded only with concrete same-resource newer successful request evidence; do not hide resets, timeouts, writes or viewer failures. Audio, target input, system network changes and stability require their own scoped results.
