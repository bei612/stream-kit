package io.github.bei612.streamkit.inputobserver;

import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

/** External CI observer. No product instrumentation, target input injection or network access. */
public final class Observer extends Instrumentation {
    private static final String CLIENT = "io.github.bei612.streamkit";
    private String role = "other";
    private String state = "unknown";
    private String rootKind = "no_root";
    private final Rect window = new Rect();
    private int visited;
    private String requestedClick;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
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
                } finally { clickDescription("收起工具栏"); }
            }
            result.putString("role", role);
            result.putString("state", state);
            result.putString("root", rootKind);
            result.putString("toolbar_opened", String.valueOf(opened));
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

    private void snapshot() {
        role = "other";
        state = "unknown";
        rootKind = "no_root";
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
            if ("已连接 · 控制中".equals(text)) role = "controller";
            if ("已连接 · 观看中".equals(text)) role = "viewer";
            if ("控制者".equals(text)) role = "controller";
            if ("仅观看".equals(text)) role = "viewer";
            String classified = classifyState(text);
            if (classified != null) state = classified;
        }
        for (int index = 0; index < children; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try { inspect(child, depth + 1); } finally { child.recycle(); }
        }
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
