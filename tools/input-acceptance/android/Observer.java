package io.github.bei612.streamkit.inputobserver;

import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Rect;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

/** External testOnly observer/control. No product instrumentation or network access. */
public final class Observer extends Instrumentation {
    private static final String CLIENT = "io.github.bei612.streamkit";
    private static final java.util.regex.Pattern AUDIO_STATS = java.util.regex.Pattern.compile("^音频 · 接收 ([0-9]+) 包$");
    private static final java.util.regex.Pattern VIDEO_STATS = java.util.regex.Pattern.compile("^视频 · 接收 ([0-9]+) 包 · 解码 ([0-9]+) 帧 · [0-9]+(?:\\.[0-9]+)? FPS$");
    private static final String NUMBER = "[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";
    private static final java.util.regex.Pattern AUDIO_FORMAT = java.util.regex.Pattern.compile("^音频编码 · ([A-Za-z][A-Za-z0-9_-]{0,31}|不可用) · 时钟 ([0-9]+ Hz|不可用) · 声道 ([0-9]+|不可用)$");
    private static final java.util.regex.Pattern AUDIO_QUALITY = java.util.regex.Pattern.compile("^音频样本 · 接收 ([0-9]+|不可用) · 补偿样本 ([0-9]+|不可用) · 累计时长 (" + NUMBER + " s|不可用) · 累计能量 (" + NUMBER + "|不可用)$");
    private String role = "other";
    private String state = "unknown";
    private String rootKind = "no_root";
    private final Rect window = new Rect();
    private int visited;
    private String requestedClick;
    private boolean diagnosticsRequested, playoutControlRequested, volumeCalibrationRequested, toolbarVisible, statisticsVisible;
    private String playback = "unknown", sound = "unknown";
    private long audioPackets = -1, videoPackets = -1, videoFrames = -1;
    private String audioCodec;
    private long audioClock = -1, audioChannels = -1, receivedSamples = -1, compensatedSamples = -1;
    private double sampleDuration = -1, totalEnergy = -1;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        diagnosticsRequested = arguments != null && "diagnostics".equals(arguments.getString("action"));
        playoutControlRequested = arguments != null && "playout-control".equals(arguments.getString("action"));
        volumeCalibrationRequested = arguments != null && "calibrate-volume".equals(arguments.getString("action"));
        if (arguments != null && "click".equals(arguments.getString("action"))) {
            requestedClick = arguments.getString("target");
            if (!"打开串流工具栏".equals(requestedClick) && !"麦克风已关闭".equals(requestedClick))
                throw new IllegalArgumentException();
        }
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (volumeCalibrationRequested) {
                result = calibrateVolume();
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (playoutControlRequested) {
                result = playoutControl();
                finish("complete".equals(result.getString("tone_result"))
                        ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
                return;
            }
            if (diagnosticsRequested) {
                result = statistics();
                result.putString("snapshot", "complete");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (requestedClick != null) {
                result.putString("clicked", String.valueOf(clickDescription(requestedClick)));
                finish(Activity.RESULT_OK, result);
                return;
            }
            // A streaming UI need not become globally idle. Observe its current
            // accessibility tree through the public instrumentation API instead.
            snapshot();
            // New releases collapse their ordinary toolbar during playback.
            // Open it as a user would, read the visible role, then restore it.
            boolean opened = "other".equals(role) && clickDescription("打开串流工具栏");
            if (opened) {
                try {
                    for (int attempt = 0; attempt < 10 && "other".equals(role); attempt++) {
                        android.os.SystemClock.sleep(50);
                        snapshot();
                    }
                } finally { closeToolbar(); }
            }
            // A queued accessibility click is not proof that the panel closed.
            // An open panel intentionally owns keyboard input in the product.
            // Re-observe a client root before handing control back to adb input.
            boolean toolbarClosed = closeToolbar();
            result.putString("role", role);
            result.putString("state", state);
            result.putString("root", rootKind);
            result.putString("toolbar_opened", String.valueOf(opened));
            result.putString("toolbar_closed", String.valueOf(toolbarClosed));
            result.putString("window", window.left + "," + window.top + "," + window.right + "," + window.bottom);
            result.putString("snapshot", "complete");
            finish(Activity.RESULT_OK, result);
        } catch (RuntimeException error) {
            // No UI text, intents, durable links or stack messages are exported.
            result.putString("snapshot", "failed");
            result.putString("error_type", error.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    // Explicit fixture preparation on the disposable emulator only. AudioManager
    // supplies this test APK's real package attribution; no shell/root identity,
    // hidden Binder calls, AppOps changes or fixed-volume/safety-policy overrides.
    // The caller independently polls the observed stream volume before playback.
    private Bundle calibrateVolume() {
        if (!"ranchu".equals(android.os.Build.HARDWARE)
                && !"goldfish".equals(android.os.Build.HARDWARE))
            throw new IllegalStateException("Emulator fixture required");
        AudioManager audio = (AudioManager) getTargetContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        if (audio == null || audio.isVolumeFixed()) throw new IllegalStateException("Adjustable audio required");
        Bundle result = new Bundle();
        int before = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        int maximum = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (maximum <= 0 || before < 0 || before > maximum) throw new IllegalStateException("Invalid music volume range");
        result.putInt("volume_before", before);
        result.putInt("volume_maximum", maximum);
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, maximum, 0);
        result.putInt("volume_after", audio.getStreamVolume(AudioManager.STREAM_MUSIC));
        result.putString("volume_set", "submitted");
        return result;
    }

    // A real public STREAM_MUSIC source, independent of the product and JavaADM.
    // It can test AudioFlinger -> HAL -> QEMU -> PulseAudio, not JavaADM.write().
    // The CI caller must run it before product admission, on an idle owned AVD.
    // No focus request, system volume/route mutation, recording or PCM injection.
    private Bundle playoutControl() {
        final int durationMs = 6000;
        Bundle result = new Bundle();
        result.putString("tone_result", "failed");
        result.putString("tone_stopped", "false");
        result.putString("tone_released", "false");
        ToneGenerator tone = null;
        try {
            tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 100);
            if (!tone.startTone(ToneGenerator.TONE_DTMF_1, durationMs)) {
                result.putString("error_type", "tone_start_rejected");
                return result;
            }
            Bundle started = new Bundle();
            started.putString("tone_started", "true");
            started.putInt("tone_duration_ms", durationMs);
            started.putInt("tone_stream", AudioManager.STREAM_MUSIC);
            started.putInt("tone_volume_percent", 100);
            started.putInt("tone_process_id", android.os.Process.myPid());
            started.putLong("tone_started_elapsed_ms", android.os.SystemClock.elapsedRealtime());
            started.putInt("tone_session_id", tone.getAudioSessionId());
            started.putInt("tone_low_hz", 697);
            started.putInt("tone_high_hz", 1209);
            sendStatus(1, started);
            android.os.SystemClock.sleep(durationMs);
            result.putString("tone_result", "complete");
        } catch (RuntimeException error) {
            result.putString("error_type", "tone_runtime_failed");
        } finally {
            if (tone != null) {
                try {
                    tone.stopTone();
                    result.putString("tone_stopped", "true");
                } catch (RuntimeException error) {
                    result.putString("tone_result", "failed");
                    result.putString("error_type", "tone_stop_failed");
                }
                try {
                    tone.release();
                    result.putString("tone_released", "true");
                } catch (RuntimeException error) {
                    result.putString("tone_result", "failed");
                    result.putString("error_type", "tone_release_failed");
                }
            }
            result.putLong("tone_finished_elapsed_ms", android.os.SystemClock.elapsedRealtime());
        }
        return result;
    }

    private void snapshot() {
        role = "other";
        state = "unknown";
        rootKind = "no_root";
        toolbarVisible = false;
        statisticsVisible = false;
        playback = "unknown";
        sound = "unknown";
        audioPackets = videoPackets = videoFrames = -1;
        audioCodec = null;
        audioClock = audioChannels = receivedSamples = compensatedSamples = -1;
        sampleDuration = totalEnergy = -1;
        window.setEmpty();
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null) return;
        try {
            rootKind = "other_app";
            if (!CLIENT.contentEquals(String.valueOf(root.getPackageName()))) return;
            rootKind = "client";
            visited = 0;
            root.getBoundsInScreen(window);
            inspect(root, 0);
        } finally { root.recycle(); }
    }

    private boolean clickDescription(String description) {
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null) return false;
        try {
            if (!CLIENT.contentEquals(String.valueOf(root.getPackageName()))) return false;
            visited = 0;
            return clickDescription(root, description, 0);
        } finally { root.recycle(); }
    }

    private boolean clickDescription(AccessibilityNodeInfo node, String description, int depth) {
        if (++visited > 512 || depth > 32) throw new IllegalStateException();
        if (node.isVisibleToUser() && node.isEnabled() && node.isClickable()
                && (description.contentEquals(String.valueOf(node.getContentDescription())) || description.contentEquals(String.valueOf(node.getText()))))
            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try { if (clickDescription(child, description, depth + 1)) return true; }
            finally { child.recycle(); }
        }
        return false;
    }

    private void inspect(AccessibilityNodeInfo node, int depth) {
        if (++visited > 512 || depth > 32) throw new IllegalStateException();
        int children = node.getChildCount();
        if (node.isVisibleToUser()) {
            String text = String.valueOf(node.getText());
            if ("收起工具栏".contentEquals(String.valueOf(node.getContentDescription()))) toolbarVisible = true;
            if ("声音已开启".equals(text)) sound = "on";
            if ("声音已关闭".equals(text)) sound = "off";
            if ("已连接 · 控制中".equals(text)) role = "controller";
            if ("已连接 · 观看中".equals(text)) role = "viewer";
            if ("控制者".equals(text)) role = "controller";
            if ("仅观看".equals(text)) role = "viewer";
            String classified = classifyState(text);
            if (classified != null) state = classified;
            for (String line : text.split("\n")) {
                java.util.regex.Matcher audio = AUDIO_STATS.matcher(line);
                java.util.regex.Matcher video = VIDEO_STATS.matcher(line);
                java.util.regex.Matcher format = AUDIO_FORMAT.matcher(line);
                java.util.regex.Matcher quality = AUDIO_QUALITY.matcher(line);
                if (audio.matches()) { statisticsVisible = true; audioPackets = Math.max(0, audioPackets) + Long.parseLong(audio.group(1)); }
                if (video.matches()) { statisticsVisible = true; videoPackets = Math.max(0, videoPackets) + Long.parseLong(video.group(1)); videoFrames = Math.max(0, videoFrames) + Long.parseLong(video.group(2)); }
                if (format.matches()) {
                    if (!"不可用".equals(format.group(1))) audioCodec = format.group(1);
                    if (!"不可用".equals(format.group(2))) audioClock = Long.parseLong(format.group(2).replace(" Hz", ""));
                    if (!"不可用".equals(format.group(3))) audioChannels = Long.parseLong(format.group(3));
                }
                if (quality.matches()) {
                    if (!"不可用".equals(quality.group(1))) receivedSamples = Long.parseLong(quality.group(1));
                    if (!"不可用".equals(quality.group(2))) compensatedSamples = Long.parseLong(quality.group(2));
                    if (!"不可用".equals(quality.group(3))) sampleDuration = Double.parseDouble(quality.group(3).replace(" s", ""));
                    if (!"不可用".equals(quality.group(4))) totalEnergy = Double.parseDouble(quality.group(4));
                }
                if ("播放 · 正在播放".equals(line)) { statisticsVisible = true; playback = "playing"; }
                if ("播放 · 已暂停".equals(line)) { statisticsVisible = true; playback = "paused"; }
                if ("播放 · 等待播放".equals(line)) { statisticsVisible = true; playback = "waiting"; }
                if ("播放 · 播放失败".equals(line)) { statisticsVisible = true; playback = "failed"; }
                if ("尚未连接".equals(line) || "等待媒体数据".equals(line)) statisticsVisible = true;
            }
        }
        for (int index = 0; index < children; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try { inspect(child, depth + 1); } finally { child.recycle(); }
        }
    }

    private boolean openToolbar() {
        snapshot();
        if (!"client".equals(rootKind)) return false;
        if (toolbarVisible) return true;
        if (!clickDescription("打开串流工具栏")) return false;
        long deadline = android.os.SystemClock.elapsedRealtime() + 2000;
        do {
            snapshot();
            if (toolbarVisible) return true;
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        return false;
    }

    private boolean closeToolbar() {
        long deadline = android.os.SystemClock.elapsedRealtime() + 2000;
        boolean requested = false;
        do {
            snapshot();
            if ("client".equals(rootKind)) {
                if (!toolbarVisible) return true;
                if (!requested) requested = clickDescription("收起工具栏");
            }
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        return false;
    }

    private Bundle statistics() {
        Bundle result = new Bundle();
        boolean closeStatistics = false;
        result.putString("statistics_available", "false");
        result.putString("statistics_fresh", "false");
        result.putString("reason", "root_unavailable");
        try {
            long rootDeadline = android.os.SystemClock.elapsedRealtime() + 2000;
            do {
                snapshot();
                if ("client".equals(rootKind)) break;
                android.os.SystemClock.sleep(50);
            } while (android.os.SystemClock.elapsedRealtime() < rootDeadline);
            if (!"client".equals(rootKind)) return result;
            closeStatistics = statisticsVisible;
            if (!openToolbar()) { result.putString("reason", "toolbar_unavailable"); return result; }
            result.putString("sound", sound);
            if (!closeStatistics) {
                if (!clickDescription("统计信息")) { result.putString("reason", "statistics_button_unavailable"); return result; }
                closeStatistics = true;
            }
            long deadline = android.os.SystemClock.elapsedRealtime() + 2000;
            long initialAudio = -1, initialVideo = -1, initialFrames = -1, initialSamples = -1;
            boolean fresh = false;
            do {
                snapshot();
                if (android.os.SystemClock.elapsedRealtime() > deadline) break;
                if (!"unknown".equals(playback) && audioPackets >= 0 && videoPackets >= 0) {
                    if (initialAudio < 0) {
                        initialAudio = audioPackets;
                        initialVideo = videoPackets;
                        initialFrames = videoFrames;
                        initialSamples = receivedSamples;
                    } else if (audioPackets > initialAudio || videoPackets > initialVideo
                            || (initialFrames >= 0 && videoFrames > initialFrames)
                            || (initialSamples >= 0 && receivedSamples > initialSamples)) {
                        fresh = true;
                        break;
                    }
                }
                android.os.SystemClock.sleep(50);
            } while (android.os.SystemClock.elapsedRealtime() < deadline);
            boolean available = !"unknown".equals(playback) && audioPackets >= 0 && videoPackets >= 0;
            result.putString("statistics_available", String.valueOf(available));
            result.putString("statistics_fresh", String.valueOf(fresh));
            result.putString("reason", !available ? "statistics_not_ready" : fresh ? "complete" : "statistics_stale");
            result.putString("playback", playback);
            if (audioPackets >= 0) result.putLong("audio_packets", audioPackets);
            if (videoPackets >= 0) result.putLong("video_packets", videoPackets);
            if (videoFrames >= 0) result.putLong("video_frames", videoFrames);
            if (audioCodec != null) result.putString("codec_name", audioCodec);
            if (audioClock >= 0) result.putLong("clock_rate", audioClock);
            if (audioChannels >= 0) result.putLong("audio_channels", audioChannels);
            if (receivedSamples >= 0) result.putLong("total_samples_received", receivedSamples);
            if (compensatedSamples >= 0) result.putLong("concealed_samples", compensatedSamples);
            if (sampleDuration >= 0 && !Double.isInfinite(sampleDuration) && !Double.isNaN(sampleDuration)) result.putDouble("total_samples_duration", sampleDuration);
            if (totalEnergy >= 0 && !Double.isInfinite(totalEnergy) && !Double.isNaN(totalEnergy)) result.putDouble("total_audio_energy", totalEnergy);
        } finally {
            if (closeStatistics && openToolbar()) clickDescription("统计信息");
            clickDescription("收起工具栏");
            long deadline = android.os.SystemClock.elapsedRealtime() + 2000;
            do {
                snapshot();
                if (!statisticsVisible && !toolbarVisible) break;
                android.os.SystemClock.sleep(50);
            } while (android.os.SystemClock.elapsedRealtime() < deadline);
            result.putString("root", rootKind);
            result.putString("statistics_closed", String.valueOf("client".equals(rootKind) && !statisticsVisible));
            result.putString("toolbar_closed", String.valueOf("client".equals(rootKind) && !toolbarVisible));
        }
        return result;
    }

    // Exact literals only: never return arbitrary UI text, input contents,
    // saved-link hints, intents or a watching capability to the host runner.
    private static String classifyState(String text) {
        switch (text) {
            case "打开应用观看链接，连接云端画面": return "entry_ready";
            case "等待连接": return "waiting";
            case "正在启动应用…": return "starting";
            case "正在建立音视频连接…": return "connecting";
            case "连接中断，正在重新连接…": return "reconnecting";
            case "已连接 · 控制中":
            case "已连接 · 观看中": return "ready";
            case "音频输出不可用，请检查设备或声音设置后重新连接": return "audio_output_failed";
            case "无法初始化本机音视频设备": return "initialize_failed";
            case "无法进入应用，请检查链接或服务器状态": return "admission_failed";
            case "服务器权限状态异常，已停止连接":
            case "恢复连接时权限校验失败": return "authority_failed";
            case "连接授权已失效，请重新打开观看链接": return "link_expired";
            case "已断开连接": return "disconnected";
            case "观看链接格式不正确":
            case "请使用有效的 HTTPS 观看链接": return "link_invalid";
            case "已保存链接无法读取，请重新粘贴": return "bookmark_unreadable";
            default: return null;
        }
    }
}
