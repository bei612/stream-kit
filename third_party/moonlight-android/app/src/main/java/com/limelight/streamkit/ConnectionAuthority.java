package com.limelight.streamkit;

/** Immutable control-plane snapshot; media tickets never grant controller authority. */
public final class ConnectionAuthority {
    public enum Role { VIEWER, CONTROLLER }
    public final String sessionId;
    public final String connectionId;
    public final long revision;
    public final long controlEpoch;
    public final Role role;
    public final boolean microphoneEnabled;
    private final String connectionToken;

    public ConnectionAuthority(String sessionId, String connectionId, String connectionToken,
                               long revision, long controlEpoch, Role role, boolean microphoneEnabled) {
        if (!identifier(sessionId) || !identifier(connectionId) || connectionToken == null ||
                connectionToken.isEmpty() || connectionToken.length() > 8192 ||
                connectionToken.matches("(?s).*\\s.*") || role == null ||
                !version(revision) || !version(controlEpoch)) {
            throw new IllegalArgumentException("Invalid connection authority snapshot");
        }
        this.sessionId = sessionId;
        this.connectionId = connectionId;
        this.connectionToken = connectionToken;
        this.revision = revision;
        this.controlEpoch = controlEpoch;
        this.role = role;
        this.microphoneEnabled = microphoneEnabled;
    }

    private static boolean identifier(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{1,128}");
    }

    private static boolean version(long value) {
        return value >= 0 && value <= 9007199254740991L;
    }

    public String authorization() { return "Bearer " + connectionToken; }

    @Override
    public String toString() {
        return "ConnectionAuthority{role=" + role + ", revision=" + revision +
                ", controlEpoch=" + controlEpoch + ", credentials=[redacted]}";
    }
}
