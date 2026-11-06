package com.limelight.streamkit;

import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.HexFormat;
import static org.junit.Assert.*;

public class ManagedInputTest {
    @Test public void matchesGatewayMixedEndianWireFormat() {
        List<byte[]> packets = new ArrayList<>();
        var pointer = new ManagedInput(packets::add);
        pointer.sendMouseMove((short) -2, (short) 3);
        pointer.sendMousePosition((short) 100, (short) 200, (short) 1920, (short) 1080);
        pointer.sendMouseButtonDown((byte) 1);
        pointer.sendMouseButtonUp((byte) 1);
        pointer.sendMouseHighResScroll((short) -120);
        pointer.sendKey((short) 0x8041, true, (byte) 3, (byte) 1);
        pointer.sendKey((short) 0x8041, false, (byte) 0, (byte) 1);
        String[] expected = {
                "06020c000000000807000000fffe0003",
                "060212000000000e05000000006400c8000007800438",
                "06020900000000050800000001",
                "06020900000000050900000001",
                "06020e000000000a0a000000ff88ff880000",
                "06020e000000000a03000000014180030000",
                "06020e000000000a04000000014180000000"
        };
        for (int i = 0; i < expected.length; i++) assertArrayEquals(HexFormat.of().parseHex(expected[i]), packets.get(i));
    }
    @Test public void relativeAsAbsoluteAccumulatesAndClamps() {
        List<byte[]> packets = new ArrayList<>();
        var pointer = new ManagedInput(packets::add);
        pointer.sendMouseMoveAsMousePosition((short) 10, (short) -20, (short) 100, (short) 80);
        pointer.sendMouseMoveAsMousePosition((short) 1000, (short) -1000, (short) 100, (short) 80);
        assertArrayEquals(HexFormat.of().parseHex("060212000000000e05000000003c0014000000640050"), packets.get(0));
        assertArrayEquals(HexFormat.of().parseHex("060212000000000e0500000000640000000000640050"), packets.get(1));
    }
}
