package com.limelight.streamkit;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;

/** Native, lightweight counterpart of the Web viewer sidebar. Never resizes the video for tools. */
final class ViewerChrome {
  static final int BACKGROUND = Color.rgb(11, 17, 28);
  static final int SURFACE = Color.rgb(21, 30, 44);
  static final int MUTED = Color.rgb(155, 170, 191);
  final FrameLayout root, media;
  final LinearLayout entry, actions;
  final TextView status, sidebarStatus;
  private final TextView authorityBadge, authorityDetail;
  final EditText address;
  final Button connect, cancel, changeServer, forget, microphone, disconnect, keyboard, keycode,
      pointer, fullscreen, stats, settings, sound;
  final Spinner mouseMode, touchMode;
  private final Activity activity;
  private final FrameLayout shade;
  private final ScrollView sidebar;
  private final Button handle;
  private boolean connected;
  private boolean hideHandle;
  Runnable onOpening = () -> {};

  ViewerChrome(Activity activity) {
    this.activity = activity;
    root = new FrameLayout(activity);
    root.setBackgroundColor(Color.BLACK);
    if (Build.VERSION.SDK_INT >= 30) {
      root.setOnApplyWindowInsetsListener((view, insets) -> {
        // Resize the complete video viewport above the IME, including immersive mode.
        // A one-pixel editor must not make Android pan the entire stream off screen.
        android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
            | android.view.WindowInsets.Type.displayCutout()
            | android.view.WindowInsets.Type.ime());
        view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
        return android.view.WindowInsets.CONSUMED;
      });
    }
    media = new FrameLayout(activity);
    root.addView(media, new FrameLayout.LayoutParams(-1, -1));
    authorityBadge = label("仅观看", 12, MUTED);
    authorityBadge.setPadding(dp(9), dp(5), dp(9), dp(5));
    authorityBadge.setBackground(background(0xCC0B111C, 6));
    authorityBadge.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    FrameLayout.LayoutParams badge =
        new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.RIGHT);
    badge.setMargins(dp(12), dp(12), dp(12), 0);
    root.addView(authorityBadge, badge);
    authorityBadge.setVisibility(View.GONE);
    entry = column();
    entry.setPadding(dp(28), dp(24), dp(28), dp(24));
    entry.setBackground(background(SURFACE, 18));
    TextView title = label("STREAM KIT", 24, Color.WHITE);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    entry.addView(title);
    status = label("打开应用观看链接，连接云端画面", 14, MUTED);
    entry.addView(status, row(-1, 52));
    address = new EditText(activity);
    address.setSingleLine(true);
    address.setTextSize(14);
    address.setTextColor(Color.WHITE);
    address.setHint("粘贴管理员提供的固定观看链接");
    address.setHintTextColor(MUTED);
    address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    address.setSaveEnabled(false);
    if (Build.VERSION.SDK_INT >= 26)
      address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
    entry.addView(address, row(-1, 56));
    connect = button("连接应用", Color.rgb(40, 107, 226));
    entry.addView(connect, spacedRow());
    cancel = button("取消连接", SURFACE);
    entry.addView(cancel, spacedRow());
    cancel.setVisibility(View.GONE);
    changeServer = button("修改服务器地址", SURFACE);
    entry.addView(changeServer, spacedRow());
    changeServer.setEnabled(false);
    forget = button("清除已保存链接", SURFACE);
    entry.addView(forget, spacedRow());
    FrameLayout.LayoutParams card = new FrameLayout.LayoutParams(
        Math.min(dp(480), activity.getResources().getDisplayMetrics().widthPixels - dp(40)), -2,
        Gravity.CENTER);
    root.addView(entry, card);

    shade = new FrameLayout(activity);
    shade.setBackgroundColor(0x66000000);
    shade.setVisibility(View.GONE);
    shade.setOnClickListener(view -> close());
    root.addView(shade, new FrameLayout.LayoutParams(-1, -1));
    sidebar = new ScrollView(activity);
    sidebar.setFillViewport(true);
    sidebar.setBackgroundColor(SURFACE);
    sidebar.setOnClickListener(view -> {});
    actions = column();
    actions.setPadding(dp(16), dp(18), dp(16), dp(20));
    sidebar.addView(actions);
    LinearLayout heading = new LinearLayout(activity);
    heading.setGravity(Gravity.CENTER_VERTICAL);
    TextView brand = label("STREAM KIT", 17, Color.WHITE);
    brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    heading.addView(brand, new LinearLayout.LayoutParams(0, dp(44), 1));
    Button close = button("×", SURFACE);
    close.setContentDescription("收起工具栏");
    close.setOnClickListener(view -> close());
    heading.addView(close, row(44, 44));
    actions.addView(heading);
    sidebarStatus = label("等待连接", 12, MUTED);
    actions.addView(sidebarStatus, row(-1, 36));
    authorityDetail = label("管理员授予控制权后，可操作应用和开启麦克风。", 12, MUTED);
    authorityDetail.setPadding(0, 0, 0, dp(10));
    actions.addView(authorityDetail, row(-1, -2));
    keyboard = button("键盘", SURFACE);
    keycode = button("发送按键", SURFACE);
    pair(keyboard, keycode);
    pointer = button("锁定鼠标", SURFACE);
    fullscreen = button("全屏", SURFACE);
    pair(pointer, fullscreen);
    stats = button("统计信息", SURFACE);
    settings = button("设置", SURFACE);
    pair(stats, settings);
    sound = button("声音已开启", SURFACE);
    microphone = button("麦克风已关闭", SURFACE);
    pair(sound, microphone);
    section("操控方式 · 即时生效");
    mouseMode = select("鼠标模式", new String[] {"相对模式", "跟随", "本地光标", "点击并拖动"});
    touchMode = select("触屏模式", new String[] {"触摸", "相对模式", "本地光标", "点击并拖动"});
    disconnect = button("退出串流", Color.rgb(68, 35, 44));
    actions.addView(disconnect, spacedRow());
    FrameLayout.LayoutParams panel = new FrameLayout.LayoutParams(
        Math.min(dp(312), activity.getResources().getDisplayMetrics().widthPixels - dp(44)), -1,
        Gravity.LEFT);
    shade.addView(sidebar, panel);
    handle = button("≡", SURFACE);
    handle.setContentDescription("打开串流工具栏");
    handle.setTextSize(23);
    FrameLayout.LayoutParams grip =
        new FrameLayout.LayoutParams(dp(40), dp(48), Gravity.LEFT | Gravity.CENTER_VERTICAL);
    root.addView(handle, grip);
    handle.setVisibility(View.GONE);
    handle.setOnClickListener(view -> open());
    shade.setOnApplyWindowInsetsListener((view, insets) -> {
      actions.setPadding(dp(16) + insets.getSystemWindowInsetLeft(),
          dp(18) + insets.getSystemWindowInsetTop(), dp(16),
          dp(20) + insets.getSystemWindowInsetBottom());
      return insets;
    });
  }

  void state(ManagedSession.ViewState state) {
    status.setText(state.status);
    sidebarStatus.setText(state.status);
    connect.setEnabled(!state.running);
    cancel.setVisibility(state.running ? View.VISIBLE : View.GONE);
    boolean firstFrame = !connected && state.videoReady;
    connected = state.videoReady;
    authorityBadge.setVisibility(connected ? View.VISIBLE : View.GONE);
    authorityBadge.setText(state.control ? "控制者" : "仅观看");
    authorityBadge.setTextColor(state.control ? Color.rgb(140, 231, 182) : MUTED);
    authorityDetail.setText(!state.control ? "仅观看 · 键盘、鼠标、触控和麦克风由管理员授权后可用。"
            : state.microphoneAllowed      ? "控制者 · 可操作应用。麦克风需主动开启。"
                                           : "控制者 · 可操作应用，管理员已关闭麦克风权限。");
    entry.setVisibility(connected ? View.GONE : View.VISIBLE);
    handle.setVisibility(connected && !hideHandle && !isOpen() ? View.VISIBLE : View.GONE);
    if (firstFrame)
      close();
    keyboard.setEnabled(state.control);
    keycode.setEnabled(state.control);
    pointer.setEnabled(state.control && Build.VERSION.SDK_INT >= 26);
    mouseMode.setEnabled(state.control);
    touchMode.setEnabled(state.control);
    for (View control : new View[] {keyboard, keycode, pointer, mouseMode, touchMode})
      control.setAlpha(control.isEnabled() ? 1f : .45f);
    microphone.setAlpha(state.microphoneAllowed ? 1f : .45f);
    if (!connected)
      close();
  }
  void open() {
    onOpening.run();
    shade.setVisibility(View.VISIBLE);
    handle.setVisibility(View.GONE);
  }
  void close() {
    shade.setVisibility(View.GONE);
    handle.setVisibility(connected && !hideHandle ? View.VISIBLE : View.GONE);
  }
  void configure(ViewerSettings settings) {
    hideHandle = settings.enabled("hideSidebarButton", false);
    String edge = settings.text("sidebarEdge", "left");
    int side = edge.equals("right") ? Gravity.RIGHT
        : edge.equals("up")         ? Gravity.TOP
        : edge.equals("down")       ? Gravity.BOTTOM
                                    : Gravity.LEFT;
    boolean horizontal = side == Gravity.TOP || side == Gravity.BOTTOM;
    FrameLayout.LayoutParams panel = (FrameLayout.LayoutParams) sidebar.getLayoutParams();
    panel.gravity = side;
    panel.width = horizontal
        ? -1
        : Math.min(dp(312), activity.getResources().getDisplayMetrics().widthPixels - dp(44));
    panel.height = horizontal
        ? Math.min(dp(420), activity.getResources().getDisplayMetrics().heightPixels - dp(44))
        : -1;
    sidebar.setLayoutParams(panel);
    FrameLayout.LayoutParams grip = (FrameLayout.LayoutParams) handle.getLayoutParams();
    grip.gravity = side | (horizontal ? Gravity.CENTER_HORIZONTAL : Gravity.CENTER_VERTICAL);
    handle.setLayoutParams(grip);
    handle.setVisibility(connected && !isOpen() && !hideHandle ? View.VISIBLE : View.GONE);
  }
  boolean isOpen() {
    return shade.getVisibility() == View.VISIBLE;
  }
  int dp(int value) {
    return (int) (value * activity.getResources().getDisplayMetrics().density + .5f);
  }
  private LinearLayout column() {
    LinearLayout view = new LinearLayout(activity);
    view.setOrientation(LinearLayout.VERTICAL);
    return view;
  }
  private LinearLayout.LayoutParams row(int width, int height) {
    return new LinearLayout.LayoutParams(
        width < 0 ? width : dp(width), height < 0 ? height : dp(height));
  }
  private LinearLayout.LayoutParams spacedRow() {
    LinearLayout.LayoutParams params = row(-1, 44);
    params.topMargin = dp(8);
    return params;
  }
  private TextView label(String text, int size, int color) {
    TextView view = new TextView(activity);
    view.setText(text);
    view.setTextSize(size);
    view.setTextColor(color);
    view.setGravity(Gravity.CENTER_VERTICAL);
    return view;
  }
  private GradientDrawable background(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(dp(radius));
    return drawable;
  }
  private Button button(String text, int color) {
    Button view = new Button(activity);
    view.setText(text);
    view.setTextSize(13);
    view.setTextColor(Color.WHITE);
    view.setAllCaps(false);
    view.setBackground(background(color, 8));
    view.setMinHeight(0);
    view.setMinimumHeight(0);
    return view;
  }
  private void pair(Button first, Button second) {
    LinearLayout line = new LinearLayout(activity);
    LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, dp(44), 1);
    left.rightMargin = dp(8);
    line.addView(first, left);
    line.addView(second, new LinearLayout.LayoutParams(0, dp(44), 1));
    actions.addView(line, spacedRow());
  }
  private void section(String title) {
    TextView view = label(title, 12, MUTED);
    LinearLayout.LayoutParams params = row(-1, 40);
    params.topMargin = dp(12);
    actions.addView(view, params);
  }
  private Spinner select(String title, String[] values) {
    actions.addView(label(title, 13, Color.WHITE), row(-1, 32));
    Spinner spinner = new Spinner(activity);
    ArrayAdapter<String> adapter =
        new ArrayAdapter<String>(activity, android.R.layout.simple_spinner_item, values) {
          @Override
          public View getView(int position, View convert, ViewGroup parent) {
            TextView view = (TextView) super.getView(position, convert, parent);
            view.setTextColor(Color.WHITE);
            view.setTextSize(14);
            return view;
          }
        };
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
    spinner.setAdapter(adapter);
    actions.addView(spinner, row(-1, 44));
    return spinner;
  }
}
