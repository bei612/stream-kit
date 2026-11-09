package com.limelight.streamkit;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.widget.*;
import org.json.JSONException;
import org.json.JSONObject;

/** The native settings editor writes Web-compatible preference keys. */
final class ViewerSettingsDialog {
  private final Activity activity;
  private final ViewerSettings settings;
  private final LinearLayout content;
  private final int gap;
  ViewerSettingsDialog(Activity activity, ViewerSettings settings) {
    this.activity = activity;
    this.settings = settings;
    gap = (int) (16 * activity.getResources().getDisplayMetrics().density);
    content = new LinearLayout(activity);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(gap, gap, gap, gap);
  }
  void show(Runnable apply) {
    label("画质 · 保存后重连生效");
    String[] sizes = {"", "720p", "1080p", "1440p", "4k", "native", "custom"};
    Spinner resolution = choice("分辨率",
        new String[] {"使用服务器配置", "720p", "1080p", "1440p", "4K", "本机分辨率", "自定义"},
        sizes, settings.text("videoSize", ""));
    JSONObject custom = settings.snapshot().optJSONObject("videoSizeCustom");
    EditText width = number("自定义宽度", custom == null ? 0 : custom.optInt("width"));
    EditText height = number("自定义高度", custom == null ? 0 : custom.optInt("height"));
    android.view.View[] customFields = {content.getChildAt(content.getChildCount()-4), width,
        content.getChildAt(content.getChildCount()-2), height};
    resolution.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
      public void onNothingSelected(AdapterView<?> parent) {}
      public void onItemSelected(AdapterView<?> parent, android.view.View view, int position, long id) {
        for(android.view.View field:customFields)
          field.setVisibility("custom".equals(sizes[position])?android.view.View.VISIBLE:android.view.View.GONE);
      }
    });
    EditText fps = number("帧率（1–240 FPS，留空使用服务器配置）", settings.number("fps", 0));
    EditText bitrate = number("码率（Kbps，留空使用服务器配置）", settings.number("bitrate", 0));
    String[] codecs = {"", "h264", "h265", "av1", "auto"};
    Spinner codec =
        choice("视频编码", new String[] {"使用服务器配置", "H.264", "HEVC / H.265", "AV1", "自动"},
            codecs, settings.text("videoCodec", ""));
    Switch local = switcher("在服务器本机播放声音", settings.enabled("playAudioLocal", false));
    label("麦克风 · 保存后重连生效");
    JSONObject mic = settings.snapshot().optJSONObject("microphoneInput");
    if (mic == null)
      mic = new JSONObject();
    java.util.List<String> deviceLabels = new java.util.ArrayList<>(),
                           deviceIds = new java.util.ArrayList<>();
    deviceLabels.add("系统默认输入设备");
    deviceIds.add("");
    if (android.os.Build.VERSION.SDK_INT >= 23) {
      android.media.AudioManager audio =
          (android.media.AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
      for (android.media.AudioDeviceInfo device :
          audio.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS)) {
        deviceLabels.add(device.getProductName() + " · " + device.getId());
        deviceIds.add(String.valueOf(device.getId()));
      }
    }
    Spinner input = choice("输入设备", deviceLabels.toArray(new String[0]),
        deviceIds.toArray(new String[0]), mic.optString("deviceId", ""));
    Switch echo = switcher("回声消除", mic.optBoolean("echoCancellation", true));
    Switch noise = switcher("噪声抑制", mic.optBoolean("noiseSuppression", true));
    Switch gain = switcher("自动增益", mic.optBoolean("autoGainControl", true));
    label("显示与操控 · 即时生效");
    Switch fullscreen =
        switcher("连接后进入全屏", settings.enabled("enterFullscreenOnStreamStart", false));
    String[] edges = {"left", "right", "up", "down"};
    Spinner edge = choice("工具栏位置", new String[] {"左侧", "右侧", "顶部", "底部"}, edges,
        settings.text("sidebarEdge", "left"));
    Switch hide =
        switcher("隐藏工具栏按钮（按返回键展开）", settings.enabled("hideSidebarButton", false));
    EditText sensitivity = number("本地光标灵敏度（10–500%）",
        (int) Math.round(settings.decimal("localCursorSensitivity", 1) * 100));
    String[] scrollModes = {"highres", "normal"};
    Spinner scroll = choice("鼠标滚轮", new String[] {"高精度", "标准"}, scrollModes,
        settings.text("mouseScrollMode", "highres"));
    label("修改画质会重新加入当前共享会话；控制权由管理员分配。麦克风需在工具栏手动开启。");
    ScrollView wrapper = new ScrollView(activity);
    wrapper.addView(content);
    AlertDialog dialog = new AlertDialog.Builder(activity)
                             .setTitle("串流设置")
                             .setView(wrapper)
                             .setNegativeButton("取消", null)
                             .setPositiveButton("保存并应用", null)
                             .create();
    dialog.setOnShowListener(
        ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
          try {
            int rate = parse(fps, 0, 1, 240), bits = parse(bitrate, 0, 1, 500000),
                speed = parse(sensitivity, 100, 10, 500);
            String size = sizes[resolution.getSelectedItemPosition()];
            JSONObject dimension = null;
            if (size.equals("custom")) {
              dimension = new JSONObject();
              dimension.put("width", parse(width, -1, 16, 8192));
              dimension.put("height", parse(height, -1, 16, 8192));
            }
            settings.set("videoSize", size.isEmpty() ? null : size);
            settings.set("videoSizeCustom", dimension);
            settings.set("fps", rate == 0 ? null : rate);
            settings.set("bitrate", bits == 0 ? null : bits);
            String encoding = codecs[codec.getSelectedItemPosition()];
            settings.set("videoCodec", encoding.isEmpty() ? null : encoding);
            if (settings.snapshot().has("playAudioLocal") || local.isChecked())
              settings.set("playAudioLocal", local.isChecked());
            JSONObject microphone = new JSONObject();
            microphone.put("deviceId", deviceIds.get(input.getSelectedItemPosition()));
            microphone.put("echoCancellation", echo.isChecked());
            microphone.put("noiseSuppression", noise.isChecked());
            microphone.put("autoGainControl", gain.isChecked());
            if (settings.snapshot().has("microphoneInput") || input.getSelectedItemPosition() != 0
                || !echo.isChecked() || !noise.isChecked() || !gain.isChecked())
              settings.set("microphoneInput", microphone);
            settings.set("enterFullscreenOnStreamStart", fullscreen.isChecked());
            settings.set("sidebarEdge", edges[edge.getSelectedItemPosition()]);
            settings.set("hideSidebarButton", hide.isChecked());
            settings.set("localCursorSensitivity", speed / 100.0);
            settings.set("mouseScrollMode", scrollModes[scroll.getSelectedItemPosition()]);
            dialog.dismiss();
            apply.run();
          } catch (IllegalArgumentException | JSONException error) {
            Toast.makeText(activity, "请检查自定义尺寸、帧率、码率和灵敏度范围", Toast.LENGTH_LONG)
                .show();
          }
        }));
    dialog.show();
  }
  private int parse(EditText field, int blank, int min, int max) {
    String text = field.getText().toString().trim();
    if (text.isEmpty() && blank >= 0)
      return blank;
    int value = Integer.parseInt(text);
    if (value < min || value > max)
      throw new IllegalArgumentException();
    return value;
  }
  private void label(String text) {
    TextView label = new TextView(activity);
    label.setText(text);
    label.setTextSize(13);
    label.setPadding(0, gap, 0, gap / 2);
    content.addView(label);
  }
  private EditText number(String title, int value) {
    label(title);
    EditText field = new EditText(activity);
    field.setInputType(InputType.TYPE_CLASS_NUMBER);
    field.setSingleLine(true);
    if (value > 0)
      field.setText(String.valueOf(value));
    content.addView(field);
    return field;
  }
  private Switch switcher(String title, boolean checked) {
    Switch field = new Switch(activity);
    field.setText(title);
    field.setChecked(checked);
    field.setPadding(0, gap, 0, gap);
    content.addView(field);
    return field;
  }
  private Spinner choice(String title, String[] labels, String[] values, String current) {
    label(title);
    Spinner field = new Spinner(activity);
    ArrayAdapter<String> adapter =
        new ArrayAdapter<>(activity, android.R.layout.simple_spinner_item, labels);
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
    field.setAdapter(adapter);
    for (int i = 0; i < values.length; i++)
      if (values[i].equals(current))
        field.setSelection(i);
    content.addView(field);
    return field;
  }
}
