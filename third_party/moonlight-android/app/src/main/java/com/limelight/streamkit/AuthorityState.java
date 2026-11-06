package com.limelight.streamkit;

/**
 * Serialized authority reducer shared by transport, heartbeat and Android lifecycle callbacks.
 * A caller must stop physical capture when canSendMicrophone() becomes false.
 * Server-side leases and epochs remain authoritative for all submitted input/audio.
 */
public final class AuthorityState {
    private ConnectionAuthority current;
    private boolean foreground;
    private boolean transportReady;
    private boolean microphoneConsent;
    private boolean authorityFresh;
    private long generation;
    private long microphoneRequestSequence;

    /** Opaque, single-use UI request bound to this connection's current authority. */
    public static final class MicrophoneRequest {
        private final AuthorityState owner;
        private final long generation, sequence;
        private MicrophoneRequest(AuthorityState owner, long generation, long sequence) {
            this.owner = owner; this.generation = generation; this.sequence = sequence;
        }
    }

    /** Invalidates every outstanding callback and clears previous session consent. */
    public synchronized long begin() {
        current = null;
        transportReady = false;
        microphoneConsent = false;
        authorityFresh = false;
        ++microphoneRequestSequence;
        return ++generation;
    }

    public synchronized void stop() { begin(); }
    public synchronized long generation() { return generation; }
    public synchronized ConnectionAuthority snapshot() { return current; }

    public synchronized boolean apply(long requestGeneration, ConnectionAuthority next) {
        if (requestGeneration != generation) return false;
        if (next == null) throw new IllegalArgumentException("Missing connection authority");
        if (current != null) {
            if (!current.sessionId.equals(next.sessionId) ||
                    !current.connectionId.equals(next.connectionId)) {
                suspend();
                throw new IllegalArgumentException("Connection identity changed");
            }
            if (next.revision < current.revision) return false;
            if (next.controlEpoch < current.controlEpoch ||
                    (next.revision == current.revision &&
                            (next.controlEpoch != current.controlEpoch || next.role != current.role ||
                                    next.microphoneEnabled != current.microphoneEnabled))) {
                suspend();
                throw new IllegalArgumentException("Inconsistent connection authority version");
            }
            if (next.controlEpoch != current.controlEpoch || next.role != current.role ||
                    next.microphoneEnabled != current.microphoneEnabled) muteMicrophone();
        }
        current = next;
        authorityFresh = true;
        if (next.role != ConnectionAuthority.Role.CONTROLLER || !next.microphoneEnabled) {
            microphoneConsent = false;
        }
        return true;
    }

    public synchronized void setForeground(boolean value) {
        foreground = value;
        if (!value) suspend();
    }

    public synchronized void setTransportReady(long requestGeneration, boolean value) {
        if (requestGeneration != generation) return;
        transportReady = value;
        if (!value) suspend();
    }

    /** Called on permission denial, authority failure, lease loss or network interruption. */
    public synchronized void suspend() {
        transportReady = false;
        microphoneConsent = false;
        authorityFresh = false;
        ++microphoneRequestSequence;
        // Late successes from before interruption cannot reactivate capture or input.
        ++generation;
    }

    /** Only an explicit UI action with RECORD_AUDIO granted may call this method. */
    public synchronized boolean requestMicrophone(boolean permissionGranted) {
        return completeMicrophoneRequest(beginMicrophoneRequest(), permissionGranted);
    }

    public synchronized MicrophoneRequest beginMicrophoneRequest() {
        if (!canSendInput() || !current.microphoneEnabled) return null;
        return new MicrophoneRequest(this, generation, ++microphoneRequestSequence);
    }

    /** A delayed Android permission result cannot grant consent to a later controller/session. */
    public synchronized boolean completeMicrophoneRequest(MicrophoneRequest request, boolean permissionGranted) {
        if (request == null || request.owner != this || request.generation != generation ||
                request.sequence != microphoneRequestSequence) return false;
        ++microphoneRequestSequence;
        microphoneConsent = permissionGranted && canSendInput() && current.microphoneEnabled;
        return microphoneConsent;
    }

    public synchronized void muteMicrophone() { microphoneConsent = false; ++microphoneRequestSequence; }

    public synchronized boolean canSendInput() {
        return foreground && transportReady && authorityFresh && current != null &&
                current.role == ConnectionAuthority.Role.CONTROLLER;
    }

    public synchronized boolean canSendMicrophone() {
        return canSendInput() && current.microphoneEnabled && microphoneConsent;
    }
}
