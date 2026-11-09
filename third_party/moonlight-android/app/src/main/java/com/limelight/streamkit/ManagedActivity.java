package com.limelight.streamkit;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.hardware.input.InputManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import com.limelight.BuildConfig;
import com.limelight.binding.input.KeyboardTranslator;
import java.util.HashMap;
import java.util.Map;
import org.webrtc.EglBase;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

/** Native application entry. Does not expose upstream standalone GameStream pairing. */
public final class ManagedActivity extends Activity {
  private ViewerChrome chrome;
  private ViewerSettings preferences;
  private EglBase egl;
  private SurfaceViewRenderer video;
  private ManagedSession session;
  private TextView status;
  private EditText address;
  private Button connect, microphone;
  private LinearLayout entry;
  private WatchLink currentLink;
  private WatchLinkStore bookmarks;
  private int entryGeneration;
  private boolean resumeOnStart;
  private AuthorityState.MicrophoneRequest pendingMicrophoneRequest;
  private int microphonePermissionCode = 100;
  private ViewerPointer touch;
  private RemoteKeyboard remoteKeyboard;
  private TextView statistics;
  private final android.os.Handler chromeHandler =
      new android.os.Handler(android.os.Looper.getMainLooper());
  private boolean fullscreen, statisticsVisible;
  private Boolean previousControl;
  private FrameLayout mediaArea;
  private int frameWidth, frameHeight;
  private AudioManager audio;
  private ManagedInput input;
  private KeyboardTranslator keyboard;
  private InputManager devices;
  private final Map<Short, Byte> pressedKeys = new HashMap<>();
  private final AudioManager.OnAudioFocusChangeListener audioFocus = change -> {
    if (session == null)
      return;
    session.audioFocus(change == AudioManager.AUDIOFOCUS_GAIN);
  };

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    getWindow().setSoftInputMode(Build.VERSION.SDK_INT >= 30
            ? WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            : WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    if (Build.VERSION.SDK_INT >= 30)
      getWindow().setDecorFitsSystemWindows(false);
    preferences = new ViewerSettings(this);
    chrome = new ViewerChrome(this);
    chrome.configure(preferences);
    status = chrome.status;
    address = chrome.address;
    entry = chrome.entry;
    connect = chrome.connect;
    microphone = chrome.microphone;
    Button forget = chrome.forget, disconnect = chrome.disconnect;
    mediaArea = chrome.media;
    video = new SurfaceViewRenderer(this);
    egl = EglBase.create();
    video.init(egl.getEglBaseContext(), new RendererCommon.RendererEvents() {
      @Override
      public void onFirstFrameRendered() {}
      @Override
      public void onFrameResolutionChanged(int width, int height, int rotation) {
        runOnUiThread(() -> {
          frameWidth = rotation % 180 == 0 ? width : height;
          frameHeight = rotation % 180 == 0 ? height : width;
          if (touch != null)
            touch.dimensions(frameWidth, frameHeight);
          fitVideo();
        });
      }
    });
    video.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
    video.setEnableHardwareScaler(true);
    mediaArea.addView(video, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
    mediaArea.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
      if (r - l != oldR - oldL || b - t != oldB - oldT)
        fitVideo();
    });
    setContentView(chrome.root);
    int width = getResources().getDisplayMetrics().widthPixels;
    int height = getResources().getDisplayMetrics().heightPixels;
    session = new ManagedSession(
        this, egl.getEglBaseContext(), video, width, height, BuildConfig.DEBUG, stateView -> {
          boolean firstVideo = entry.getVisibility() != View.GONE && stateView.videoReady;
          chrome.state(stateView);
          if (stateView.running && stateView.videoReady && previousControl != null
              && previousControl != stateView.control) {
            Toast
                .makeText(this,
                    stateView.control ? "已获得控制权，可操作应用和主动开启麦克风"
                                      : "控制权已收回，已停止输入和麦克风，仅可观看",
                    Toast.LENGTH_LONG)
                .show();
          }
          previousControl = stateView.running && stateView.videoReady ? stateView.control : null;
          chrome.changeServer.setEnabled(!stateView.running && currentLink != null);
          if (firstVideo && preferences.enabled("enterFullscreenOnStreamStart", false))
            setFullscreen(true);
          if (!stateView.control && remoteKeyboard != null)
            remoteKeyboard.hideKeyboard();
          microphone.setEnabled(stateView.microphoneAllowed && pendingMicrophoneRequest == null);
          if (!stateView.control) {
            pressedKeys.clear();
            if (touch != null)
              touch.cancel();
            if (Build.VERSION.SDK_INT >= 26)
              video.releasePointerCapture();
          }
          microphone.setText(!stateView.control   ? "麦克风 · 需控制权"
                  : !stateView.microphoneAllowed  ? "麦克风 · 未授权"
                  : stateView.microphoneLive      ? "麦克风开启中"
                  : stateView.microphoneRequested ? "正在开启麦克风…"
                                                  : "麦克风已关闭");
          connect.setEnabled(!stateView.running);
        });
    audio = (AudioManager) getSystemService(AUDIO_SERVICE);
    bookmarks = new WatchLinkStore(this, BuildConfig.DEBUG);
    bookmarks.load((saved, unreadable) -> {
      if (entryGeneration != 0 || address.length() != 0)
        return;
      if (saved != null) {
        currentLink = saved;
        savedLinkHint();
      } else if (unreadable)
        status.setText("已保存链接无法读取，请重新粘贴");
    });
    forget.setOnClickListener(view -> {
      ++entryGeneration;
      currentLink = null;
      chrome.changeServer.setEnabled(false);
      address.setText("");
      address.setHint("粘贴管理员提供的固定观看链接");
      bookmarks.clear();
      resumeOnStart = false;
      session.stop();
      video.clearImage();
    });
    chrome.changeServer.setOnClickListener(view -> changeServerAddress());
    input = new ManagedInput(packet -> session.sendInput(packet));
    keyboard = new KeyboardTranslator();
    devices = (InputManager) getSystemService(INPUT_SERVICE);
    devices.registerInputDeviceListener(keyboard, null);
    ViewerCursor cursor = new ViewerCursor(this, video);
    mediaArea.addView(cursor, new FrameLayout.LayoutParams(-1, -1));
    touch = new ViewerPointer(input, video, cursor, preferences, () -> session.canControl());
    video.setOnTouchListener(touch);
    video.setOnGenericMotionListener(touch);
    video.setFocusableInTouchMode(true);
    if (Build.VERSION.SDK_INT >= 26)
      video.setOnCapturedPointerListener((view, event) -> touch.captured(event));
    bindViewerTools();
    connect.setOnClickListener(view -> connect());
    disconnect.setOnClickListener(view -> {
      resumeOnStart = false;
      touch.cancel();
      remoteKeyboard.hideKeyboard();
      if (Build.VERSION.SDK_INT >= 26)
        video.releasePointerCapture();
      releaseKeys();
      session.stop();
      audio.abandonAudioFocus(audioFocus);
      video.clearImage();
    });
    chrome.cancel.setOnClickListener(view -> disconnect.performClick());
    microphone.setEnabled(false);
    microphone.setOnClickListener(view -> {
      if (session.microphoneRequested()) {
        session.muteMicrophone();
        return;
      }
      AuthorityState.MicrophoneRequest request = session.beginMicrophoneRequest();
      if (request == null)
        return;
      if (Build.VERSION.SDK_INT >= 23
          && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
              != PackageManager.PERMISSION_GRANTED) {
        pendingMicrophoneRequest = request;
        microphone.setEnabled(false);
        microphonePermissionCode =
            microphonePermissionCode == 65535 ? 100 : microphonePermissionCode + 1;
        requestPermissions(
            new String[] {Manifest.permission.RECORD_AUDIO}, microphonePermissionCode);
      } else
        enableMicrophone(request);
    });
    readIntent(getIntent());
  }

  private boolean sessionRunning() {
    return session != null && session.isRunning();
  }
  private void connect() {
    try {
      String entered = address.getText().toString().trim();
      if (!entered.isEmpty() || currentLink == null) {
        currentLink = WatchLink.parse(entered, BuildConfig.DEBUG);
        int generation = ++entryGeneration;
        bookmarks.save(currentLink, saved -> {
          if (!saved && generation == entryGeneration)
            Toast.makeText(this, "链接仅供本次使用，无法安全保存到设备", Toast.LENGTH_LONG).show();
        });
      }
      address.setText("");
      savedLinkHint();
      acquireAudioFocus();
      session.viewerSettings(preferences.snapshot());
      session.start(currentLink);
    } catch (IllegalArgumentException error) {
      status.setText(BuildConfig.DEBUG ? "观看链接格式不正确" : "请使用有效的 HTTPS 观看链接");
    }
  }
  private void savedLinkHint() {
    address.setHint("当前应用 · " + currentLink.origin());
    chrome.changeServer.setEnabled(!sessionRunning());
  }
  private void changeServerAddress() {
    if (currentLink == null || sessionRunning())
      return;
    WatchLink original = currentLink;
    int originalGeneration = entryGeneration;
    EditText endpoint = new EditText(this);
    endpoint.setSingleLine(true);
    endpoint.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
    endpoint.setText(currentLink.origin().toString());
    endpoint.setSelectAllOnFocus(true);
    android.app.AlertDialog dialog =
        new android.app.AlertDialog.Builder(this)
            .setTitle("修改服务器地址")
            .setMessage("填写服务器的新 HTTPS 地址和端口，保留当前应用的观看密钥。服务器沿用原 CA "
                + "信任时，无需重装 App 或证书。")
            .setView(endpoint)
            .setNegativeButton("取消", null)
            .setPositiveButton("保存地址", null)
            .create();
    dialog.setOnShowListener(ignored
        -> dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
      if (entryGeneration != originalGeneration || currentLink != original || sessionRunning()) {
        dialog.dismiss();
        return;
      }
      try {
        WatchLink next = original.withOrigin(endpoint.getText().toString(), BuildConfig.DEBUG);
        currentLink = next;
        int generation = ++entryGeneration;
        bookmarks.save(next, saved -> {
          if (!saved && generation == entryGeneration)
            Toast.makeText(this, "地址仅供本次使用，无法安全保存到设备", Toast.LENGTH_LONG).show();
        });
        address.setText("");
        savedLinkHint();
        status.setText("服务器地址已更新，点击连接应用");
        dialog.dismiss();
      } catch (IllegalArgumentException error) {
        endpoint.setError("请输入有效的 HTTPS 服务器地址，例如 https://192.168.1.10:9000");
      }
    }));
    dialog.show();
  }
  private void enableMicrophone(AuthorityState.MicrophoneRequest request) {
    if (!session.canControl()) {
      session.microphone(request, false);
      return;
    }
    if (!acquireAudioFocus()) {
      session.microphone(request, false);
      Toast.makeText(this, "音频正在被其他应用使用", Toast.LENGTH_SHORT).show();
      return;
    }
    session.microphone(request, true);
  }
  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == microphonePermissionCode && pendingMicrophoneRequest != null) {
      AuthorityState.MicrophoneRequest pending = pendingMicrophoneRequest;
      pendingMicrophoneRequest = null;
      if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
        enableMicrophone(pending);
      else
        session.microphone(pending, false);
    }
  }
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    readIntent(intent);
  }
  private void readIntent(Intent intent) {
    if (intent != null && intent.getData() != null) {
      address.setText(intent.getDataString());
      // Capability is not retained in the Activity's relaunch intent or saved-instance bundle.
      intent.setData(null);
      connect();
    }
  }
  @Override
  protected void onStart() {
    super.onStart();
    if (resumeOnStart && currentLink != null) {
      resumeOnStart = false;
      acquireAudioFocus();
      session.start(currentLink);
    }
  }
  @Override
  protected void onResume() {
    super.onResume();
    // Android 15+ requires a foreground app for audio-focus acquisition.
    if (sessionRunning())
      acquireAudioFocus();
    chromeHandler.removeCallbacks(updateStatistics);
    if (statisticsVisible)
      chromeHandler.post(updateStatistics);
  }
  @Override
  protected void onStop() {
    pendingMicrophoneRequest = null;
    chromeHandler.removeCallbacks(updateStatistics);
    remoteKeyboard.hideKeyboard();
    resumeOnStart = sessionRunning();
    touch.cancel();
    releaseKeys();
    session.stop();
    audio.abandonAudioFocus(audioFocus);
    super.onStop();
  }
  @Override
  protected void onDestroy() {
    devices.unregisterInputDeviceListener(keyboard);
    bookmarks.close();
    session.close();
    video.release();
    egl.release();
    super.onDestroy();
  }
  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    int code = event.getKeyCode();
    if (session != null && session.canControl() && entry.getVisibility() == View.GONE
        && !chrome.isOpen() && code != KeyEvent.KEYCODE_BACK && code != KeyEvent.KEYCODE_VOLUME_UP
        && code != KeyEvent.KEYCODE_VOLUME_DOWN && code != KeyEvent.KEYCODE_VOLUME_MUTE
        && !KeyEvent.isGamepadButton(code)
        && (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP)) {
      short key = keyboard.translate(code, event.getDeviceId());
      if (key != 0) {
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        byte flags = (byte) (keyboard.hasNormalizedMapping(code, event.getDeviceId()) ? 0 : 1);
        byte modifiers = (byte) ((event.isShiftPressed() ? 1 : 0) | (event.isCtrlPressed() ? 2 : 0)
            | (event.isAltPressed() ? 4 : 0) | (event.isMetaPressed() ? 8 : 0));
        if (down && event.getRepeatCount() == 0) {
          input.sendKey(key, true, modifiers, flags);
          pressedKeys.put(key, flags);
        } else if (!down && pressedKeys.remove(key) != null)
          input.sendKey(key, false, modifiers, flags);
        return true;
      }
    }
    return super.dispatchKeyEvent(event);
  }
  @Override
  public void onWindowFocusChanged(boolean focused) {
    super.onWindowFocusChanged(focused);
    if (!focused) {
      releaseKeys();
      if (touch != null)
        touch.cancel();
    }
  }
  private void releaseKeys() {
    if (input != null)
      for (Map.Entry<Short, Byte> key : pressedKeys.entrySet())
        input.sendKey(key.getKey(), false, (byte) 0, key.getValue());
    pressedKeys.clear();
  }
  private void bindViewerTools() {
    chrome.onOpening = () -> {
      releaseKeys();
      touch.cancel();
      if (remoteKeyboard != null)
        remoteKeyboard.hideKeyboard();
      if (Build.VERSION.SDK_INT >= 26)
        video.releasePointerCapture();
    };
    remoteKeyboard = new RemoteKeyboard(this, new RemoteKeyboard.Output() {
      @Override
      public void text(String value) {
        if (session.canControl())
          input.sendText(value);
      }
      @Override
      public void key(int key) {
        sendKey(key);
      }
    });
    chrome.root.addView(remoteKeyboard, new FrameLayout.LayoutParams(1, 1, Gravity.TOP));
    chrome.keyboard.setOnClickListener(view -> {
      if (session.canControl()) {
        chrome.close();
        remoteKeyboard.showKeyboard();
      }
    });
    chrome.keycode.setOnClickListener(view -> showKeyPicker());
    chrome.pointer.setEnabled(Build.VERSION.SDK_INT >= 26);
    chrome.pointer.setOnClickListener(view -> {
      if (Build.VERSION.SDK_INT >= 26 && session.canControl()) {
        chrome.close();
        video.requestFocus();
        if (video.hasPointerCapture())
          video.releasePointerCapture();
        else
          video.requestPointerCapture();
      }
    });
    chrome.fullscreen.setOnClickListener(view -> setFullscreen(!fullscreen));
    chrome.sound.setOnClickListener(view -> {
      boolean enabled = !preferences.enabled("audioEnabled", true);
      preferences.set("audioEnabled", enabled);
      session.playback(enabled);
      chrome.sound.setText(enabled ? "声音已开启" : "声音已关闭");
    });
    session.playback(preferences.enabled("audioEnabled", true));
    chrome.sound.setText(preferences.enabled("audioEnabled", true) ? "声音已开启" : "声音已关闭");
    statistics = label("", 12, Color.WHITE);
    statistics.setTypeface(Typeface.MONOSPACE);
    statistics.setPadding(dp(10), dp(8), dp(10), dp(8));
    statistics.setBackgroundColor(0xb0101826);
    statistics.setVisibility(View.GONE);
    FrameLayout.LayoutParams statsPosition =
        new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.RIGHT);
    statsPosition.setMargins(dp(12), dp(12), dp(12), 0);
    chrome.root.addView(statistics, statsPosition);
    chrome.stats.setOnClickListener(view -> {
      statisticsVisible = !statisticsVisible;
      statistics.setVisibility(statisticsVisible ? View.VISIBLE : View.GONE);
      chromeHandler.removeCallbacks(updateStatistics);
      if (statisticsVisible)
        chromeHandler.post(updateStatistics);
      chrome.close();
    });
    chrome.settings.setOnClickListener(view -> {
      releaseKeys();
      touch.cancel();
      org.json.JSONObject before = preferences.snapshot();
      new ViewerSettingsDialog(this, preferences).show(() -> {
        touch.configure();
        session.viewerSettings(preferences.snapshot());
        chrome.configure(preferences);
        if (sessionRunning() && currentLink != null
            && ViewerSettings.requiresReconnect(before, preferences.snapshot())) {
          chrome.close();
          session.start(currentLink);
        }
      });
    });
    bindMode(chrome.mouseMode, "mouseMode",
        new String[] {"relative", "follow", "localCursor", "pointAndDrag"}, "follow");
    bindMode(chrome.touchMode, "touchMode",
        new String[] {"touch", "mouseRelative", "localCursor", "pointAndDrag"}, "mouseRelative");
  }
  private void bindMode(Spinner spinner, String key, String[] values, String fallback) {
    for (int i = 0; i < values.length; i++)
      if (values[i].equals(preferences.text(key, fallback)))
        spinner.setSelection(i);
    spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
      @Override
      public void onNothingSelected(AdapterView<?> parent) {}
      @Override
      public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
        if (!values[position].equals(preferences.text(key, fallback))) {
          touch.cancel();
          preferences.set(key, values[position]);
          touch.configure();
        }
      }
    });
  }
  private void sendKey(int key) {
    if (!session.canControl())
      return;
    input.sendKey((short) key, true, (byte) 0, (byte) 0);
    input.sendKey((short) key, false, (byte) 0, (byte) 0);
  }
  private void showKeyPicker() {
    if (!session.canControl())
      return;
    LinearLayout container = new LinearLayout(this);
    container.setOrientation(LinearLayout.VERTICAL);
    container.setPadding(dp(16), 0, dp(16), 0);
    EditText search = new EditText(this);
    search.setHint("搜索按键，如 Enter、F1、A");
    search.setSingleLine(true);
    container.addView(search);
    java.util.List<String> names = new java.util.ArrayList<>();
    final java.util.Map<String, Integer> keys = new java.util.HashMap<>();
    for (int key = 1; key <= 255; key++) {
      String name = key >= 65 && key <= 90 ? String.valueOf((char) key)
          : key >= 48 && key <= 57         ? String.valueOf((char) key)
          : key >= 112 && key <= 135       ? "F" + (key - 111)
                                           : String.format(java.util.Locale.ROOT, "VK_%02X", key);
      switch (key) {
        case 8:
          name = "Backspace";
          break;
        case 9:
          name = "Tab";
          break;
        case 13:
          name = "Enter";
          break;
        case 16:
          name = "Shift";
          break;
        case 17:
          name = "Ctrl";
          break;
        case 18:
          name = "Alt";
          break;
        case 27:
          name = "Esc";
          break;
        case 32:
          name = "Space";
          break;
        case 37:
          name = "Left";
          break;
        case 38:
          name = "Up";
          break;
        case 39:
          name = "Right";
          break;
        case 40:
          name = "Down";
          break;
        case 46:
          name = "Delete";
          break;
        case 91:
          name = "Win";
          break;
      }
      names.add(name);
      keys.put(name, key);
    }
    ArrayAdapter<String> adapter =
        new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, names);
    ListView list = new ListView(this);
    list.setAdapter(adapter);
    container.addView(list, new LinearLayout.LayoutParams(-1, dp(280)));
    android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
                                         .setTitle("发送按键")
                                         .setView(container)
                                         .setNegativeButton("取消", null)
                                         .create();
    list.setOnItemClickListener((parent, view, position, id) -> {
      Integer key = keys.get(adapter.getItem(position));
      if (key != null)
        sendKey(key);
      dialog.dismiss();
    });
    search.addTextChangedListener(new android.text.TextWatcher() {
      public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
      public void onTextChanged(CharSequence text, int start, int before, int count) {
        adapter.getFilter().filter(text);
      }
      public void afterTextChanged(android.text.Editable text) {}
    });
    dialog.show();
  }
  private final Runnable updateStatistics = new Runnable() {
    @Override
    public void run() {
      if (!statisticsVisible || isFinishing())
        return;
      session.statistics(text -> {
        if (statisticsVisible)
          statistics.setText(text);
      });
      chromeHandler.postDelayed(this, 1000);
    }
  };
  private void setFullscreen(boolean enabled) {
    fullscreen = enabled;
    chrome.fullscreen.setText(enabled ? "退出全屏" : "全屏");
    if (Build.VERSION.SDK_INT >= 30) {
      android.view.WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) {
        controller.setSystemBarsBehavior(
            android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        int bars = android.view.WindowInsets.Type.statusBars()
            | android.view.WindowInsets.Type.navigationBars();
        if (enabled)
          controller.hide(bars);
        else
          controller.show(bars);
      }
      chrome.root.requestApplyInsets();
      return;
    }
    getWindow().getDecorView().setSystemUiVisibility(enabled
            ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }
  @Override
  public void onBackPressed() {
    if (chrome.isOpen())
      chrome.close();
    else if (sessionRunning()) {
      remoteKeyboard.hideKeyboard();
      if (Build.VERSION.SDK_INT >= 26)
        video.releasePointerCapture();
      chrome.open();
    } else
      super.onBackPressed();
  }
  private int dp(int value) {
    return (int) (value * getResources().getDisplayMetrics().density + .5f);
  }
  private boolean acquireAudioFocus() {
    boolean granted =
        audio.requestAudioFocus(audioFocus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    session.audioFocus(granted);
    return granted;
  }
  private void fitVideo() {
    if (frameWidth <= 0 || frameHeight <= 0 || mediaArea == null || mediaArea.getWidth() == 0
        || mediaArea.getHeight() == 0)
      return;
    double scale = Math.min(
        (double) mediaArea.getWidth() / frameWidth, (double) mediaArea.getHeight() / frameHeight);
    video.setLayoutParams(new FrameLayout.LayoutParams(Math.max(1, (int) (frameWidth * scale)),
        Math.max(1, (int) (frameHeight * scale)), Gravity.CENTER));
  }
  private TextView label(String text, int size, int color) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextSize(size);
    view.setTextColor(color);
    view.setGravity(Gravity.CENTER_VERTICAL);
    return view;
  }
}
