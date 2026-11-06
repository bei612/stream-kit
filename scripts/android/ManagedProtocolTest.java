import com.limelight.streamkit.AuthorityState;
import com.limelight.streamkit.ConnectionAuthority;
import com.limelight.streamkit.ConnectionAuthority.Role;
import com.limelight.streamkit.WatchLink;

public final class ManagedProtocolTest {
    private static final String KEY = "A".repeat(43);
    private static int checks;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    private static void rejects(Runnable action, String message) {
        try { action.run(); } catch (IllegalArgumentException expected) {
            check(!expected.toString().contains(KEY), "Error leaked capability");
            return;
        }
        throw new AssertionError(message);
    }

    private static ConnectionAuthority authority(long revision, long epoch, Role role) {
        return new ConnectionAuthority("session-1", "connection-1", "private-token",
                revision, epoch, role, true);
    }

    public static void main(String[] args) {
        WatchLink link = WatchLink.parse("https://192.168.3.66:9000/watch#key=" + KEY, false);
        check(link.admissionEndpoint().toString().equals("https://192.168.3.66:9000/api/v1/watch/open"),
                "Capability must not enter request URL");
        check(!link.toString().contains(KEY), "Diagnostic leaked capability");
        check(link.admissionAuthorization().equals("Bearer " + KEY), "Missing admission credential");
        rejects(() -> WatchLink.parse("http://192.168.3.66/watch#key=" + KEY, false), "Production HTTP");
        check(WatchLink.parse("http://10.0.2.2:9000/watch#key=" + KEY, true).origin().getPort() == 9000,
                "Explicit development HTTP unavailable");
        rejects(() -> WatchLink.parse("https://admin:secret@host/watch#key=" + KEY, false), "User info");
        rejects(() -> WatchLink.parse("https://host/watch?key=" + KEY + "#key=" + KEY, false), "Query secret");
        rejects(() -> WatchLink.parse("https://host/watch#key=" + KEY + "&key=" + KEY, false), "Duplicate key");
        rejects(() -> WatchLink.parse("https://host:65536/watch#key=" + KEY, false), "Invalid port");
        rejects(() -> WatchLink.parse("https://host/%77atch#key=" + KEY, false), "Ambiguous path");
        rejects(() -> WatchLink.parse("https://bad host/watch#key=" + KEY, false), "Invalid URI");
        rejects(() -> new ConnectionAuthority("s", "c", "token", -1, 0, Role.VIEWER, true), "Negative version");
        check(!authority(1, 0, Role.VIEWER).toString().contains("private-token"), "Token leaked");

        AuthorityState state = new AuthorityState();
        long run = state.begin();
        state.setForeground(true);
        state.apply(run, authority(1, 0, Role.VIEWER));
        state.setTransportReady(run, true);
        check(!state.canSendInput() && !state.requestMicrophone(true), "Viewer gained input/microphone");
        state.apply(run, authority(2, 1, Role.CONTROLLER));
        check(state.canSendInput() && !state.canSendMicrophone(), "Grant auto-started microphone");
        check(!state.requestMicrophone(false), "Android permission denial ignored");
        check(state.requestMicrophone(true) && state.canSendMicrophone(), "Authorized capture denied");
        check(!state.apply(run, authority(1, 0, Role.VIEWER)) && state.canSendMicrophone(), "Stale snapshot won");
        state.apply(run, authority(3, 2, Role.VIEWER));
        check(!state.canSendInput() && !state.canSendMicrophone(), "Revocation did not close authority");
        state.apply(run, authority(4, 3, Role.CONTROLLER));
        check(!state.canSendMicrophone(), "New epoch inherited consent");
        check(state.requestMicrophone(true), "Explicit consent after grant failed");
        state.setForeground(false);
        state.setForeground(true);
        state.setTransportReady(run, true);
        check(!state.apply(run, authority(5, 3, Role.CONTROLLER)) && !state.canSendInput(),
                "Pre-background callback resurrected authority");
        run = state.generation();
        state.setTransportReady(run, true);
        check(!state.canSendInput(), "Transport alone restored expired authority");
        state.apply(run, authority(5, 3, Role.CONTROLLER));
        check(state.canSendInput() && !state.canSendMicrophone(), "Foreground recovery consent");
        state.requestMicrophone(true);
        long beforeDisconnect = run;
        state.suspend();
        state.setTransportReady(beforeDisconnect, true);
        check(!state.apply(beforeDisconnect, authority(6, 3, Role.CONTROLLER)) && !state.canSendMicrophone(),
                "Pre-disconnect callback resurrected microphone");
        run = state.generation();
        state.apply(run, authority(6, 3, Role.CONTROLLER));
        state.setTransportReady(run, true);
        final long currentRun = run;
        rejects(() -> state.apply(currentRun, authority(7, 2, Role.CONTROLLER)), "Epoch regression");
        check(!state.canSendInput(), "Invalid authority failed open");
        run = state.generation();
        state.apply(run, authority(8, 4, Role.CONTROLLER));
        state.setTransportReady(run, true);
        state.stop();
        check(!state.apply(run, authority(9, 4, Role.CONTROLLER)) && state.snapshot() == null,
                "Late response revived stopped session");
        permissionResultRaces();
        System.out.println("Android managed protocol: " + checks + " checks passed");
    }

    private static void permissionResultRaces() {
        AuthorityState state = new AuthorityState();
        long run = state.begin();
        state.setForeground(true);
        state.apply(run, authority(1, 1, Role.CONTROLLER));
        state.setTransportReady(run, true);
        AuthorityState.MicrophoneRequest pending = state.beginMicrophoneRequest();
        // Ordinary heartbeats must not force the user to repeat the permission gesture.
        state.apply(run, authority(2, 1, Role.CONTROLLER));
        check(state.completeMicrophoneRequest(pending, true), "Benign heartbeat invalidated pending permission");
        check(!state.completeMicrophoneRequest(pending, false) && state.canSendMicrophone(), "Repeated permission result mutated consent");
        state.muteMicrophone();
        pending = state.beginMicrophoneRequest();
        state.apply(run, authority(3, 2, Role.VIEWER));
        state.apply(run, authority(4, 3, Role.CONTROLLER));
        check(!state.completeMicrophoneRequest(pending, true) && !state.canSendMicrophone(), "Old permission result enabled new controller epoch");
        pending = state.beginMicrophoneRequest();
        state.apply(run, new ConnectionAuthority("session-1", "connection-1", "private-token", 5, 3, Role.CONTROLLER, false));
        state.apply(run, authority(6, 3, Role.CONTROLLER));
        check(!state.completeMicrophoneRequest(pending, true) && !state.canSendMicrophone(), "Policy disable/enable resurrected pending consent");
        pending = state.beginMicrophoneRequest();
        state.muteMicrophone();
        check(!state.completeMicrophoneRequest(pending, true), "Audio-focus loss did not invalidate pending consent");
        pending = state.beginMicrophoneRequest();
        state.stop();
        run = state.generation();
        state.apply(run, authority(7, 4, Role.CONTROLLER));
        state.setTransportReady(run, true);
        check(!state.completeMicrophoneRequest(pending, true) && !state.canSendMicrophone(), "Stopped session's permission enabled reconnected microphone");
        pending = state.beginMicrophoneRequest();
        check(state.completeMicrophoneRequest(pending, true), "New explicit permission denied");
        AuthorityState other = new AuthorityState();
        long otherRun = other.begin();
        other.setForeground(true);
        other.apply(otherRun, authority(7, 4, Role.CONTROLLER));
        other.setTransportReady(otherRun, true);
        check(!other.completeMicrophoneRequest(pending, true), "Permission request crossed session owner");
    }
}
