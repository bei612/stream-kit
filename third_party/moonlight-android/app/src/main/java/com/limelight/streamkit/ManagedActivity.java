package com.limelight.streamkit;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import com.limelight.BuildConfig;
import com.limelight.binding.input.touch.AbsoluteTouchContext;
import org.webrtc.EglBase;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

/** Native application entry. Does not expose upstream standalone GameStream pairing. */
public final class ManagedActivity extends Activity {
    private EglBase egl;
    private SurfaceViewRenderer video;
    private ManagedSession session;
    private TextView status;
    private EditText address;
    private Button connect, microphone;
    private LinearLayout entry;
    private WatchLink currentLink;
    private boolean resumeOnStart;
    private boolean microphoneRequested;
    private AbsoluteTouchContext touch;
    private FrameLayout mediaArea;
    private int frameWidth, frameHeight;
    private AudioManager audio;
    private final AudioManager.OnAudioFocusChangeListener audioFocus = change -> {
        if (session == null) return;
        if (change != AudioManager.AUDIOFOCUS_GAIN) microphoneRequested = false;
        session.audioFocus(change == AudioManager.AUDIOFOCUS_GAIN);
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(11, 17, 28));
        root.setPadding(dp(20), dp(18), dp(20), dp(18));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(20) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(),
                    dp(20) + insets.getSystemWindowInsetRight(), dp(12) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView title = label("STREAM KIT", 20, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(title);
        status = label("打开应用观看链接，连接云端画面", 14, Color.rgb(155, 170, 191));
        root.addView(status, new LinearLayout.LayoutParams(-1, dp(42)));
        entry = new LinearLayout(this);
        entry.setOrientation(LinearLayout.VERTICAL);
        address = new EditText(this);
        address.setHint("粘贴管理员提供的固定观看链接");
        address.setHintTextColor(Color.rgb(125, 145, 169));
        address.setTextColor(Color.WHITE);
        address.setTextSize(14);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setSingleLine(true);
        address.setSaveEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        entry.addView(address, new LinearLayout.LayoutParams(-1, dp(56)));
        connect = button("连接应用", Color.rgb(40, 107, 226));
        entry.addView(connect);
        root.addView(entry);
        video = new SurfaceViewRenderer(this);
        egl = EglBase.create();
        video.init(egl.getEglBaseContext(), new RendererCommon.RendererEvents() {
            @Override public void onFirstFrameRendered() { }
            @Override public void onFrameResolutionChanged(int width, int height, int rotation) {
                runOnUiThread(() -> { frameWidth = rotation % 180 == 0 ? width : height; frameHeight = rotation % 180 == 0 ? height : width; fitVideo(); });
            }
        });
        video.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        video.setEnableHardwareScaler(true);
        LinearLayout.LayoutParams videoParams = new LinearLayout.LayoutParams(-1, 0, 1);
        videoParams.topMargin = dp(12);
        mediaArea = new FrameLayout(this);
        mediaArea.addView(video, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        mediaArea.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> { if (r - l != oldR - oldL || b - t != oldB - oldT) fitVideo(); });
        root.addView(mediaArea, videoParams);
        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        microphone = button("麦克风已关闭", Color.rgb(37, 49, 67));
        controls.addView(microphone, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button disconnect = button("断开", Color.rgb(37, 49, 67));
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(dp(90), dp(48));
        stopParams.leftMargin = dp(12);
        controls.addView(disconnect, stopParams);
        root.addView(controls);
        setContentView(root);
        int width = getResources().getDisplayMetrics().widthPixels;
        int height = getResources().getDisplayMetrics().heightPixels;
        session = new ManagedSession(this, egl.getEglBaseContext(), video, width, height, BuildConfig.DEBUG,
                (message, control, live, videoReady) -> {
                    status.setText(message);
                    microphone.setEnabled(control);
                    if (!control) { microphoneRequested = false; if (touch != null) touch.cancelTouch(); }
                    microphone.setText(live ? "麦克风开启中" : microphoneRequested ? "正在开启麦克风…" : "麦克风已关闭");
                    connect.setEnabled(!sessionRunning());
                    entry.setVisibility(videoReady ? View.GONE : View.VISIBLE);
                });
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        touch = new AbsoluteTouchContext(new ManagedPointer(packet -> session.sendInput(packet)), 0, video);
        video.setOnTouchListener((view, event) -> {
            if (!session.canControl()) return true;
            touch.setPointerCount(event.getPointerCount());
            int x = (int) event.getX(), y = (int) event.getY();
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: touch.touchDownEvent(x, y, event.getEventTime(), true); break;
                case MotionEvent.ACTION_MOVE: touch.touchMoveEvent(x, y, event.getEventTime()); break;
                case MotionEvent.ACTION_UP: touch.touchUpEvent(x, y, event.getEventTime()); view.performClick(); break;
                case MotionEvent.ACTION_CANCEL: touch.cancelTouch(); break;
            }
            return true;
        });
        connect.setOnClickListener(view -> connect());
        disconnect.setOnClickListener(view -> { resumeOnStart = false; session.stop(); video.clearImage(); });
        microphone.setEnabled(false);
        microphone.setOnClickListener(view -> {
            if (microphoneRequested) { microphoneRequested = false; session.microphone(false, false); return; }
            if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
            else enableMicrophone();
        });
        readIntent(getIntent());
    }

    private boolean sessionRunning() { return session != null && session.isRunning(); }
    private void connect() {
        try {
            currentLink = WatchLink.parse(address.getText().toString(), BuildConfig.DEBUG);
            microphoneRequested = false;
            acquireAudioFocus();
            session.start(currentLink);
        } catch (IllegalArgumentException error) {
            status.setText(BuildConfig.DEBUG ? "观看链接格式不正确" : "请使用有效的 HTTPS 观看链接");
        }
    }
    private void enableMicrophone() {
        if (!session.canControl()) return;
        if (!acquireAudioFocus()) { Toast.makeText(this, "音频正在被其他应用使用", Toast.LENGTH_SHORT).show(); return; }
        microphoneRequested = true;
        session.microphone(true, true);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) enableMicrophone();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readIntent(intent); }
    private void readIntent(Intent intent) {
        if (intent != null && intent.getData() != null) {
            address.setText(intent.getDataString());
            // Capability is not retained in the Activity's relaunch intent or saved-instance bundle.
            intent.setData(null);
            connect();
        }
    }
    @Override protected void onStart() {
        super.onStart();
        if (resumeOnStart && currentLink != null) { resumeOnStart = false; acquireAudioFocus(); session.start(currentLink); }
    }
    @Override protected void onStop() {
        resumeOnStart = sessionRunning();
        microphoneRequested = false;
        touch.cancelTouch();
        session.stop();
        audio.abandonAudioFocus(audioFocus);
        super.onStop();
    }
    @Override protected void onDestroy() {
        session.close();
        video.release();
        egl.release();
        super.onDestroy();
    }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + .5f); }
    private boolean acquireAudioFocus() {
        boolean granted = audio.requestAudioFocus(audioFocus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        session.audioFocus(granted);
        return granted;
    }
    private void fitVideo() {
        if (frameWidth <= 0 || frameHeight <= 0 || mediaArea == null || mediaArea.getWidth() == 0 || mediaArea.getHeight() == 0) return;
        double scale = Math.min((double) mediaArea.getWidth() / frameWidth, (double) mediaArea.getHeight() / frameHeight);
        video.setLayoutParams(new FrameLayout.LayoutParams(Math.max(1, (int) (frameWidth * scale)), Math.max(1, (int) (frameHeight * scale)), Gravity.CENTER));
    }
    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); view.setGravity(Gravity.CENTER_VERTICAL); return view;
    }
    private Button button(String text, int color) {
        Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setTextColor(Color.WHITE);
        GradientDrawable background = new GradientDrawable(); background.setColor(color); background.setCornerRadius(dp(10)); button.setBackground(background);
        return button;
    }
}
