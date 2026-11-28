package com.limelight.streamkit;

import org.junit.Test;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class ManagedLanDnsTest {
    @Test
    public void discoveryIsLimitedToTheOriginalLocalAuthority() {
        assertTrue(ManagedLanDns.allowsDiscovery("RENDER.local.", "render.local"));
        assertFalse(ManagedLanDns.allowsDiscovery("gateway.local", "render.local"));
        assertFalse(ManagedLanDns.allowsDiscovery("render.local.example", "render.local.example"));
        assertFalse(ManagedLanDns.allowsDiscovery("192.168.0.8", "192.168.0.8"));
        assertFalse(ManagedLanDns.allowsDiscovery("render.local", null));
    }
}
