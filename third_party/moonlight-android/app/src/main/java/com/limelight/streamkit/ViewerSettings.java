package com.limelight.streamkit;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/** Viewer overrides use the same names and values as Web mlSettings. No credentials. */
final class ViewerSettings {
  private final SharedPreferences storage;
  private JSONObject values;

  ViewerSettings(Context context) {
    storage = context.getSharedPreferences("streamkit-viewer-settings", Context.MODE_PRIVATE);
    try {
      values = new JSONObject(storage.getString("settings", "{}"));
    } catch (JSONException error) {
      values = new JSONObject();
    }
  }

  String text(String key, String fallback) {
    return values.optString(key, fallback);
  }
  int number(String key, int fallback) {
    return values.optInt(key, fallback);
  }
  double decimal(String key, double fallback) {
    return values.optDouble(key, fallback);
  }
  boolean enabled(String key, boolean fallback) {
    return values.optBoolean(key, fallback);
  }

  void set(String key, Object value) {
    try {
      values.put(key, value);
    } catch (JSONException error) {
      throw new IllegalArgumentException("Invalid viewer setting");
    }
    storage.edit().putString("settings", values.toString()).apply();
  }

  JSONObject snapshot() {
    try {
      return new JSONObject(values.toString());
    } catch (JSONException error) {
      throw new IllegalStateException("Invalid viewer preferences");
    }
  }

  /** Merge only native media options; UI/input preferences never enter media negotiation. */
  static JSONObject mediaProfile(JSONObject profile, JSONObject overrides) {
    try {
      JSONObject copy = new JSONObject(profile.toString());
      JSONObject defaults = copy.optJSONObject("default_settings");
      if (defaults == null) {
        defaults = new JSONObject();
        copy.put("default_settings", defaults);
      }
      for (String key : new String[] {
               "videoSize", "videoSizeCustom", "fps", "bitrate", "videoCodec", "playAudioLocal"}) {
        if (overrides.has(key))
          defaults.put(key, overrides.get(key));
      }
      return copy;
    } catch (JSONException error) {
      throw new IllegalArgumentException("Invalid media preferences");
    }
  }

  static boolean requiresReconnect(JSONObject before, JSONObject after) {
    for (String key :
        new String[] {"videoSize", "fps", "bitrate", "videoCodec", "playAudioLocal"}) {
      if (!java.util.Objects.equals(
              String.valueOf(before.opt(key)), String.valueOf(after.opt(key))))
        return true;
    }
    if ("custom".equals(after.optString("videoSize"))
        && !sameFields(before.optJSONObject("videoSizeCustom"),
            after.optJSONObject("videoSizeCustom"), new String[] {"width", "height"}))
      return true;
    if (!sameFields(before.optJSONObject("microphoneInput"), after.optJSONObject("microphoneInput"),
            new String[] {"deviceId", "echoCancellation", "noiseSuppression", "autoGainControl"}))
      return true;
    return false;
  }
  private static boolean sameFields(JSONObject left, JSONObject right, String[] keys) {
    if (left == null || right == null)
      return left == right;
    for (String key : keys)
      if (!java.util.Objects.equals(String.valueOf(left.opt(key)), String.valueOf(right.opt(key))))
        return false;
    return true;
  }
}
