package com.limelight.streamkit;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.limelight.nvstream.StreamConfiguration;
import org.webrtc.EglBase;
import org.webrtc.PeerConnection;
import org.webrtc.VideoSink;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Main-thread session owner; network calls never block capture revocation or UI lifecycle. */
public final class ManagedSession implements AutoCloseable {
    public interface Listener { void changed(ViewState state); }
    /** One immutable projection prevents UI from inventing authority or capture state. */
    public static final class ViewState {
        public final String status;
        public final boolean running, control, microphoneAllowed, microphoneRequested, microphoneLive, videoReady;
        ViewState(String status, boolean running, boolean control, boolean microphoneAllowed,
                  boolean microphoneRequested, boolean microphoneLive, boolean videoReady) {
            this.status = status; this.running = running; this.control = control;
            this.microphoneAllowed = microphoneAllowed; this.microphoneRequested = microphoneRequested;
            this.microphoneLive = microphoneLive; this.videoReady = videoReady;
        }
    }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newFixedThreadPool(3);
    private final Context context;
    private final EglBase.Context egl;
    private final VideoSink sink;
    private final Listener listener;
    private final AuthorityState authority = new AuthorityState();
    private final boolean development;
    private final int width, height;
    private ManagedApi api;
    private ManagedApi.Admission admission;
    private ManagedApi.Ticket ticket;
    private ManagedApi.Answer answer;
    private NativePeer peer;
    private WatchLink link;
    private long operation;
    private long lastAuthority;
    private long nextHeartbeat;
    private long openDeadline;
    private boolean running;
    private boolean closed;
    private boolean heartbeatPending;
    private boolean recovering;
    private boolean microphoneLive;
    private boolean videoReady;
    private boolean audible;
    private int retryCount;
    private int pendingWork;
    private String status = "等待连接";

    public ManagedSession(Context context, EglBase.Context egl, VideoSink sink,
                          int width, int height, boolean development, Listener listener) {
        this.context = context.getApplicationContext(); this.egl = egl; this.sink = sink;
        this.width = width; this.height = height; this.development = development; this.listener = listener;
    }

    public void start(WatchLink link) {
        checkThread();
        if (closed) return;
        stop();
        this.link = link;
        api = new ManagedApi(link, development);
        running = true;
        authority.setForeground(true);
        openDeadline = SystemClock.elapsedRealtime() + 120000;
        open(operation);
    }

    private void open(long op) {
        show("正在启动应用…");
        ManagedApi client = api;
        WatchLink requestedLink = link;
        submit(() -> {
            try {
                ManagedApi.Admission joined = client.open(requestedLink);
                main.post(() -> {
                    if (!valid(op)) { submit(() -> leaveQuietly(client, joined.authority)); return; }
                    admission = joined;
                    authority.apply(authority.generation(), joined.authority);
                    lastAuthority = SystemClock.elapsedRealtime();
                    nextHeartbeat = 0;
                    main.post(pulse);
                    prepareMedia(op);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (!valid(op)) return;
                    if (error instanceof ManagedApi.Failure && ((ManagedApi.Failure) error).status == 503 &&
                            SystemClock.elapsedRealtime() < openDeadline) main.postDelayed(() -> { if (valid(op)) open(op); }, 2500);
                    else fail("无法进入应用，请检查链接或服务器状态");
                });
            }
        });
    }

    private void prepareMedia(long op) {
        show("正在建立音视频连接…");
        ManagedApi client = api;
        ManagedApi.Admission joined = admission;
        ConnectionAuthority current = authority.snapshot();
        submit(() -> {
            try {
                ManagedApi.Ticket fresh = client.ticket(current);
                List<PeerConnection.IceServer> ice = MediaProfile.iceServers(client.iceConfiguration(joined, fresh));
                StreamConfiguration settings = MediaProfile.settings(client.profile(joined, fresh), width, height);
                main.post(() -> {
                    if (!valid(op)) return;
                    ticket = fresh;
                    try {
                        peer = new NativePeer(context, egl, sink, ice, authority, new NativePeer.Listener() {
                            @Override public void offerReady(String sdp) { sendOffer(op, sdp); }
                            @Override public void connected() {
                                if (!valid(op)) return;
                                authority.setTransportReady(authority.generation(), true);
                                retryCount = 0;
                                show(authority.canSendInput() ? "已连接 · 控制中" : "已连接 · 观看中");
                            }
                            @Override public void failed(String reason) { if (valid(op)) recover(); }
                            @Override public void frameReceived() {
                                if (valid(op)) { videoReady = true; publish(); }
                            }
                            @Override public void microphoneState(boolean live) {
                                if (!valid(op)) return;
                                microphoneLive = live && authority.canSendMicrophone();
                                nextHeartbeat = 0;
                                publish();
                            }
                        });
                        peer.audible(audible);
                        peer.createOffer(joined.hostId, joined.appId, settings);
                    } catch (Exception error) { fail("无法初始化本机音视频设备"); }
                });
            } catch (Exception error) { main.post(() -> { if (valid(op)) recover(); }); }
        });
    }

    private void sendOffer(long op, String sdp) {
        if (!valid(op)) return;
        ManagedApi client = api;
        ManagedApi.Admission joined = admission;
        ConnectionAuthority current = authority.snapshot();
        submit(() -> {
            try {
                ManagedApi.Ticket fresh = client.ticket(current);
                ManagedApi.Answer response = client.offer(joined, fresh, sdp);
                main.post(() -> {
                    if (!valid(op)) { deleteQuietly(client, joined, fresh, response); return; }
                    ticket = fresh;
                    answer = response;
                    peer.answer(response.sdp);
                });
            } catch (Exception error) { main.post(() -> { if (valid(op)) recover(); }); }
        });
    }

    private final Runnable pulse = new Runnable() {
        @Override public void run() {
            if (!running || admission == null || recovering) return;
            if (SystemClock.elapsedRealtime() - lastAuthority >= 12000) { recover(); return; }
            if (!heartbeatPending && SystemClock.elapsedRealtime() >= nextHeartbeat) heartbeat();
            main.postDelayed(this, 500);
        }
    };

    private void heartbeat() {
        heartbeatPending = true;
        long op = operation, generation = authority.generation(), sentAt = SystemClock.elapsedRealtime();
        nextHeartbeat = sentAt + 5000;
        ManagedApi client = api;
        ConnectionAuthority current = authority.snapshot();
        boolean microphone = authority.canSendMicrophone(), live = microphoneLive;
        submit(() -> {
            try {
                ConnectionAuthority snapshot = client.heartbeat(current, microphone, live);
                main.post(() -> {
                    if (!valid(op)) return;
                    heartbeatPending = false;
                    try {
                        if (authority.apply(generation, snapshot)) lastAuthority = sentAt;
                        if (peer != null && !authority.canSendMicrophone()) { peer.setMicrophone(false); microphoneLive = false; }
                        if (peer != null && !recovering && status.startsWith("已连接")) status = authority.canSendInput() ? "已连接 · 控制中" : "已连接 · 观看中";
                        publish();
                    } catch (Exception error) { fail("服务器权限状态异常，已停止连接"); }
                });
            } catch (Exception error) { main.post(() -> { if (valid(op)) { heartbeatPending = false; recover(); } }); }
        });
    }

    private void recover() {
        if (!running || recovering || admission == null) return;
        recovering = true;
        long op = ++operation;
        main.removeCallbacks(pulse);
        authority.suspend();
        closeMedia();
        heartbeatPending = false;
        show("连接中断，正在重新连接…");
        long delay = Math.min(10000, 1000L << Math.min(retryCount++, 3));
        main.postDelayed(() -> resume(op), delay);
    }

    private void resume(long op) {
        if (!valid(op)) return;
        ManagedApi client = api;
        ConnectionAuthority current = authority.snapshot();
        long sentAt = SystemClock.elapsedRealtime(), generation = authority.generation();
        submit(() -> {
            try {
                ConnectionAuthority snapshot = client.resume(current);
                main.post(() -> {
                    if (!valid(op)) return;
                    try { authority.apply(generation, snapshot); }
                    catch (Exception error) { fail("恢复连接时权限校验失败"); return; }
                    lastAuthority = sentAt;
                    recovering = false;
                    nextHeartbeat = 0;
                    main.post(pulse);
                    prepareMedia(op);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (!valid(op)) return;
                    if (error instanceof ManagedApi.Failure && (((ManagedApi.Failure) error).status == 401 || ((ManagedApi.Failure) error).status == 410)) {
                        fail("连接授权已失效，请重新打开观看链接");
                    } else { recovering = false; recover(); }
                });
            }
        });
    }

    public AuthorityState.MicrophoneRequest beginMicrophoneRequest() {
        checkThread();
        return authority.beginMicrophoneRequest();
    }

    public void microphone(AuthorityState.MicrophoneRequest request, boolean permissionGranted) {
        checkThread();
        authority.completeMicrophoneRequest(request, permissionGranted && audible);
        synchronizeMicrophone();
    }

    public void muteMicrophone() {
        checkThread();
        authority.muteMicrophone();
        synchronizeMicrophone();
    }

    private void synchronizeMicrophone() {
        if (peer != null) peer.setMicrophone(authority.canSendMicrophone());
        if (!authority.canSendMicrophone()) microphoneLive = false;
        nextHeartbeat = 0;
        publish();
    }

    public boolean sendInput(byte[] packet) { checkThread(); return peer != null && peer.sendControl(packet); }
    public boolean isRunning() { return running; }
    public boolean canControl() { return authority.canSendInput(); }
    public boolean microphoneRequested() { return authority.canSendMicrophone(); }
    public void audioFocus(boolean granted) {
        checkThread();
        audible = granted;
        if (!granted) muteMicrophone();
        if (peer != null) peer.audible(granted);
    }

    public void stop() {
        checkThread();
        ++operation;
        running = false;
        recovering = false;
        heartbeatPending = false;
        main.removeCallbacks(pulse);
        ConnectionAuthority previous = authority.snapshot();
        ManagedApi previousApi = api;
        authority.stop();
        closeMedia();
        admission = null;
        if (previous != null && previousApi != null) submit(() -> leaveQuietly(previousApi, previous));
        show("已断开连接");
    }

    private void closeMedia() {
        videoReady = false;
        if (peer != null) { peer.close(); peer = null; }
        microphoneLive = false;
        if (answer != null && ticket != null && admission != null) deleteQuietly(api, admission, ticket, answer);
        answer = null;
        ticket = null;
    }

    private void deleteQuietly(ManagedApi client, ManagedApi.Admission joined, ManagedApi.Ticket credential, ManagedApi.Answer media) {
        submit(() -> { try { client.deleteMedia(joined, credential, media.resource); } catch (IOException ignored) { } });
    }
    private static void leaveQuietly(ManagedApi client, ConnectionAuthority connection) {
        try { client.leave(connection); } catch (IOException ignored) { }
    }
    private boolean valid(long op) { return running && !closed && operation == op; }
    private void fail(String message) { stop(); show(message); }
    private void show(String value) { status = value; publish(); }
    private void publish() {
        ConnectionAuthority current = authority.snapshot();
        boolean control = authority.canSendInput();
        listener.changed(new ViewState(status, running, control, control && current != null && current.microphoneEnabled,
                authority.canSendMicrophone(), microphoneLive, videoReady));
    }
    private void submit(Runnable task) {
        checkThread();
        pendingWork++;
        network.execute(() -> {
            try { task.run(); }
            finally {
                // Results are posted before this completion on the same Handler. Late-result
                // cleanup can therefore enqueue its own work before the executor is drained.
                main.post(() -> {
                    pendingWork--;
                    if (closed && pendingWork == 0) network.shutdown();
                });
            }
        });
    }
    private static void checkThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Session commands must use main looper");
    }
    @Override public void close() {
        if (closed) return;
        stop();
        closed = true;
        if (pendingWork == 0) network.shutdown();
    }
}
