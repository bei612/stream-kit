package io.github.bei612.streamkit.inputobserver;

import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

/** External CI observer. No product instrumentation, input injection or network access. */
public final class Observer extends Instrumentation {
    private static final String CLIENT = "io.github.bei612.streamkit";
    private String role = "other";
    private final Rect window = new Rect();
    private int visited;

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            // A streaming UI need not become globally idle. Observe its current
            // accessibility tree through the public instrumentation API instead.
            AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
            if (root != null) {
                try {
                    if (CLIENT.contentEquals(String.valueOf(root.getPackageName()))) {
                        root.getBoundsInScreen(window);
                        inspect(root, 0);
                    }
                }
                finally { root.recycle(); }
            }
            result.putString("role", role);
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

    private void inspect(AccessibilityNodeInfo node, int depth) {
        if (++visited > 512 || depth > 32) throw new IllegalStateException();
        int children = node.getChildCount();
        if (node.isVisibleToUser()) {
            String text = String.valueOf(node.getText());
            if ("已连接 · 控制中".equals(text)) role = "controller";
            if ("已连接 · 观看中".equals(text)) role = "viewer";
        }
        for (int index = 0; index < children; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try { inspect(child, depth + 1); } finally { child.recycle(); }
        }
    }
}
