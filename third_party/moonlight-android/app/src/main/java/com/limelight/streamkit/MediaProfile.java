package com.limelight.streamkit;

import com.limelight.nvstream.StreamConfiguration;
import com.limelight.nvstream.jni.MoonBridge;
import org.json.JSONObject;
import org.webrtc.PeerConnection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class MediaProfile {
    // The managed gateway supplies stereo content PCM at this rate. Android
    // remains responsible for adapting content playback to the output device.
    static final int PLAYBACK_SAMPLE_RATE_HZ = 48000;

    static StreamConfiguration settings(JSONObject profile, int screenWidth, int screenHeight) {
        JSONObject defaults = profile.optJSONObject("default_settings");
        if (defaults == null) defaults = new JSONObject();
        int width = 1920, height = 1080;
        switch (defaults.optString("videoSize", "1080p")) {
            case "720p": width = 1280; height = 720; break;
            case "1440p": width = 2560; height = 1440; break;
            case "4k": width = 3840; height = 2160; break;
            case "native": width = screenWidth; height = screenHeight; break;
            case "custom":
                JSONObject custom = defaults.optJSONObject("videoSizeCustom");
                if (custom != null) { width = custom.optInt("width", width); height = custom.optInt("height", height); }
                break;
        }
        int fps = defaults.optInt("fps", 60);
        int bitrate = defaults.optInt("bitrate", 10000);
        JSONObject permissions = profile.optJSONObject("permissions");
        if (permissions != null && !permissions.isNull("maximum_bitrate_kbps")) {
            bitrate = Math.min(bitrate, permissions.optInt("maximum_bitrate_kbps", bitrate));
        }
        if (width < 16 || height < 16 || width > 8192 || height > 8192 || fps < 1 || fps > 240 || bitrate < 1) {
            throw new IllegalArgumentException("Invalid server media profile");
        }
        int formats = preferredVideoFormats(defaults);
        return new StreamConfiguration.Builder().setResolution(width, height).setRefreshRate(fps)
                .setSupportedVideoFormats(formats)
                .setAudioConfiguration(MoonBridge.AUDIO_CONFIGURATION_STEREO)
                .setBitrate(bitrate).enableLocalAudioPlayback(defaults.optBoolean("playAudioLocal", false)).build();
    }

    /** Same x-moonlight-preferred-codec mask as Web getVideoCodecHint and Rust VideoFormats. */
    static int preferredVideoFormats(JSONObject defaults) {
        switch (defaults.optString("videoCodec", "h264")) {
            case "h264": return 0x0005;
            case "h265": return 0x0f00;
            case "av1": return 0xf000;
            case "auto": return 0xff05;
            default: throw new IllegalArgumentException("Unsupported server video codec preference");
        }
    }

    /** Parse quoted Link parameters without splitting TURN credentials at embedded commas. */
    static List<PeerConnection.IceServer> iceServers(String header) {
        List<PeerConnection.IceServer> result = new ArrayList<>();
        if (header == null || header.trim().isEmpty()) return result;
        if (header.length() > 65536) throw new IllegalArgumentException("ICE configuration too large");
        int index = 0;
        while (index < header.length()) {
            while (index < header.length() && (Character.isWhitespace(header.charAt(index)) || header.charAt(index) == ',')) index++;
            if (index == header.length()) break;
            if (header.charAt(index++) != '<') throw new IllegalArgumentException("Invalid ICE link");
            int end = header.indexOf('>', index);
            if (end < 0) throw new IllegalArgumentException("Invalid ICE link");
            String url = header.substring(index, end);
            index = end + 1;
            Map<String, String> parameters = new HashMap<>();
            while (index < header.length()) {
                while (index < header.length() && Character.isWhitespace(header.charAt(index))) index++;
                if (index == header.length() || header.charAt(index) == ',') break;
                if (header.charAt(index++) != ';') throw new IllegalArgumentException("Invalid ICE parameter");
                while (index < header.length() && Character.isWhitespace(header.charAt(index))) index++;
                int start = index;
                while (index < header.length() && header.charAt(index) != '=' && header.charAt(index) != ';' && header.charAt(index) != ',') index++;
                if (index == header.length() || header.charAt(index++) != '=') throw new IllegalArgumentException("Invalid ICE parameter");
                String name = header.substring(start, index - 1).trim();
                while (index < header.length() && Character.isWhitespace(header.charAt(index))) index++;
                StringBuilder value = new StringBuilder();
                boolean quoted = index < header.length() && header.charAt(index) == '"';
                if (quoted) {
                    index++;
                    boolean terminated = false;
                    while (index < header.length()) {
                        char ch = header.charAt(index++);
                        if (ch == '"') { terminated = true; break; }
                        if (ch == '\\') {
                            if (index == header.length()) throw new IllegalArgumentException("Invalid ICE escape");
                            ch = header.charAt(index++);
                        }
                        value.append(ch);
                    }
                    if (!terminated) throw new IllegalArgumentException("Invalid ICE quote");
                } else {
                    while (index < header.length() && header.charAt(index) != ';' && header.charAt(index) != ',') value.append(header.charAt(index++));
                }
                if (parameters.put(name, quoted ? value.toString() : value.toString().trim()) != null) throw new IllegalArgumentException("Duplicate ICE parameter");
            }
            if ("ice-server".equals(parameters.get("rel"))) {
                if (!url.matches("(?i)(stun|stuns|turn|turns):[^\\s<>]+") || result.size() >= 16) throw new IllegalArgumentException("Invalid ICE server");
                result.add(PeerConnection.IceServer.builder(url)
                        .setUsername(parameters.getOrDefault("username", ""))
                        .setPassword(parameters.getOrDefault("credential", "")).createIceServer());
            }
        }
        return result;
    }
}
