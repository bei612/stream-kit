package io.github.bei612.streamkit.inputobserver;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

/** External CI observer. No product instrumentation, input injection or network access. */
public final class Observer extends Instrumentation {
    private static final String CLIENT = "io.github.bei612.streamkit";
    private String role = "other";
    private final Rect surface = new Rect();
    private int visited;
    private int surfaces;

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            // A streaming UI need not become globally idle. Observe its current
            // accessibility tree through the public instrumentation API instead.
            UiAutomation automation = getUiAutomation();
            AccessibilityServiceInfo service = automation.getServiceInfo();
            // SurfaceView carries pixels rather than accessible text, so Android
            // may omit it from the default compressed accessibility hierarchy.
            service.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            automation.setServiceInfo(service);
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) {
                try { if (CLIENT.contentEquals(String.valueOf(root.getPackageName()))) inspect(root, 0, "", 0); }
                finally { root.recycle(); }
            }
            result.putString("role", role);
            if (surfaces > 1) throw new IllegalStateException();
            result.putString("surface", surface.left + "," + surface.top + "," + surface.right + "," + surface.bottom);
            result.putString("snapshot", "complete");
            finish(Activity.RESULT_OK, result);
        } catch (RuntimeException error) {
            // No UI text, intents, durable links or stack messages are exported.
            result.putString("snapshot", "failed");
            result.putString("error_type", error.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void inspect(AccessibilityNodeInfo node, int depth, String parentType, int siblings) {
        if (++visited > 512 || depth > 32) throw new IllegalStateException();
        String type = String.valueOf(node.getClassName());
        int children = node.getChildCount();
        if (node.isVisibleToUser()) {
            String text = String.valueOf(node.getText());
            if ("已连接 · 控制中".equals(text)) role = "controller";
            if ("已连接 · 观看中".equals(text)) role = "viewer";
            // SurfaceView inherits View's accessibility class name. Match the
            // published ManagedActivity structure: its sole video child within
            // the media FrameLayout. Reject ambiguity instead of guessing taps.
            if ("android.view.View".equals(type) && "android.widget.FrameLayout".equals(parentType) && siblings == 1 && children == 0) {
                Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
                if (bounds.width() >= 100 && bounds.height() >= 100) { surfaces++; surface.set(bounds); }
            }
        }
        for (int index = 0; index < children; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try { inspect(child, depth + 1, type, children); } finally { child.recycle(); }
        }
    }
}
