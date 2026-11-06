package com.limelight.streamkit;

import org.json.JSONObject;
import org.junit.Test;
import org.webrtc.PeerConnection;
import java.util.List;
import static org.junit.Assert.*;

public class MediaProfileTest {
    @Test public void sendsSameCodecPreferenceAsWebInsteadOfOpeningUnrestrictedUpstream() throws Exception {
        assertEquals(5, MediaProfile.preferredVideoFormats(new JSONObject()));
        for (Object[] pair : new Object[][]{{"h264", 5}, {"h265", 3840}, {"av1", 61440}, {"auto", 65285}}) {
            assertEquals((int) pair[1], MediaProfile.preferredVideoFormats(new JSONObject().put("videoCodec", pair[0])));
        }
        assertThrows(IllegalArgumentException.class, () -> MediaProfile.preferredVideoFormats(new JSONObject().put("videoCodec", "unexpected")));
    }
    @Test public void preservesQuotedTurnCredentialsAndMultipleServers() {
        List<PeerConnection.IceServer> servers = MediaProfile.iceServers(
                "<turn:relay.example:3478?transport=udp>; rel=\"ice-server\"; username=\" user \"; credential=\" a,b\\\"c\\\\d \"; credential-type=\"password\", " +
                "<stun:stun.example:3478>; rel=ice-server");
        assertEquals(2, servers.size());
        assertEquals(" user ", servers.get(0).username);
        assertEquals(" a,b\"c\\d ", servers.get(0).password);
        assertEquals("stun:stun.example:3478", servers.get(1).urls.get(0));
    }
    @Test public void rejectsAmbiguousOrMalformedIceConfiguration() {
        for (String header : new String[] {
                "<turn:relay>; rel=ice-server; credential=one; credential=two",
                "<turn:relay>; rel=\"ice-server",
                "<http://relay>; rel=ice-server",
                "<turn:relay>; rel=\"ice-server\"junk"
        }) assertThrows(IllegalArgumentException.class, () -> MediaProfile.iceServers(header));
    }
    @Test public void rejectsInvalidProfileBeforeNativeConfiguration() throws Exception {
        JSONObject invalid = new JSONObject("{\"default_settings\":{\"fps\":0}}");
        assertThrows(IllegalArgumentException.class, () -> MediaProfile.settings(invalid, 1080, 2400));
    }
}
