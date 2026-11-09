package com.limelight.streamkit;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

public class ViewerSettingsTest {
  @Test
  public void mediaOverridesCannotReplaceServerPermissionsOrLeakUiPreferences() throws Exception {
    JSONObject profile = new JSONObject("{\"default_settings\":{\"fps\":60,\"bitrate\":10000},"
                                        + "\"permissions\":{\"maximum_bitrate_kbps\":12000}}");
    JSONObject overrides =
        new JSONObject("{\"fps\":30,\"bitrate\":50000,\"mouseMode\":\"relative\",\"permissions\":{"
                       + "\"maximum_bitrate_kbps\":999999}}");
    JSONObject merged = ViewerSettings.mediaProfile(profile, overrides);
    assertEquals(60, profile.getJSONObject("default_settings").getInt("fps"));
    assertEquals(30, merged.getJSONObject("default_settings").getInt("fps"));
    assertEquals(12000, merged.getJSONObject("permissions").getInt("maximum_bitrate_kbps"));
    assertFalse(merged.getJSONObject("default_settings").has("mouseMode"));
  }
  @Test
  public void localDisplayAndInputChangesDoNotReconnectOrResetAuthority() throws Exception {
    JSONObject before = new JSONObject("{\"fps\":60,\"videoSize\":\"custom\",\"videoSizeCustom\":{"
                                       + "\"width\":1920,\"height\":1080}}");
    JSONObject after = new JSONObject(before.toString());
    after.put("sidebarEdge", "right")
        .put("touchMode", "localCursor")
        .put("localCursorSensitivity", 1.5)
        .put("hideSidebarButton", true);
    after.put("videoSizeCustom", new JSONObject("{\"height\":1080,\"width\":1920}"));
    assertFalse(ViewerSettings.requiresReconnect(before, after));
    after.put("fps", 30);
    assertTrue(ViewerSettings.requiresReconnect(before, after));
  }
  @Test
  public void microphoneProcessingAndCustomDimensionsRequireRenegotiation() throws Exception {
    JSONObject before = new JSONObject(
        "{\"videoSize\":\"custom\",\"videoSizeCustom\":{\"width\":1920,\"height\":1080},"
        + "\"microphoneInput\":{\"deviceId\":\"\",\"echoCancellation\":true}}");
    JSONObject after = new JSONObject(before.toString());
    after.getJSONObject("microphoneInput").put("echoCancellation", false);
    assertTrue(ViewerSettings.requiresReconnect(before, after));
    after = new JSONObject(before.toString());
    after.getJSONObject("videoSizeCustom").put("width", 1280);
    assertTrue(ViewerSettings.requiresReconnect(before, after));
  }
}
