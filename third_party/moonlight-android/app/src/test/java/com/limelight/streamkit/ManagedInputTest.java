package com.limelight.streamkit;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import org.junit.Test;

public class ManagedInputTest {
  @Test
  public void textMatchesWebUtf8PacketAndKeepsCodePointsIntact() throws Exception {
    List<byte[]> packets = new ArrayList<>();
    var input = new ManagedInput(packets::add);
    input.sendText("你A");
    assertArrayEquals(HexFormat.of().parseHex("06020c000000000817000000e4bda041"), packets.get(0));
    packets.clear();
    String text = "a".repeat(29) + "😀你好";
    input.sendText(text);
    StringBuilder reconstructed = new StringBuilder();
    for (byte[] packet : packets) {
      assertTrue(packet.length <= 42);
      java.nio.ByteBuffer payload = java.nio.ByteBuffer.wrap(packet, 12, packet.length - 12);
      reconstructed.append(java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(payload));
    }
    assertEquals(text, reconstructed.toString());
    assertEquals(2, packets.size());
  }
  @Test
  public void touchMatchesSunshinePacketAndRejectsNonFiniteCoordinates() {
    List<byte[]> packets = new ArrayList<>();
    var input = new ManagedInput(packets::add);
    input.sendTouch(1, 7, .25f, .75f, 1);
    assertArrayEquals(
        HexFormat.of().parseHex(
            "06022400000000200200005501000000070000000000803e0000403f0000803f0000000000000000"),
        packets.get(0));
    input.sendTouch(1, 1, Float.NaN, 0, 1);
    input.sendTouch(1, 1, 0, 0, Float.POSITIVE_INFINITY);
    assertEquals(1, packets.size());
  }
  @Test
  public void matchesGatewayMixedEndianWireFormat() {
    List<byte[]> packets = new ArrayList<>();
    var pointer = new ManagedInput(packets::add);
    pointer.sendMouseMove((short) -2, (short) 3);
    pointer.sendMousePosition((short) 100, (short) 200, (short) 1920, (short) 1080);
    pointer.sendMouseButtonDown((byte) 1);
    pointer.sendMouseButtonUp((byte) 1);
    pointer.sendMouseHighResScroll((short) -120);
    pointer.sendKey((short) 0x8041, true, (byte) 3, (byte) 1);
    pointer.sendKey((short) 0x8041, false, (byte) 0, (byte) 1);
    String[] expected = {"06020c000000000807000000fffe0003",
        "060212000000000e05000000006400c8000007800438", "06020900000000050800000001",
        "06020900000000050900000001", "06020e000000000a0a000000ff88ff880000",
        "06020e000000000a03000000014100030000", "06020e000000000a04000000014100000000"};
    for (int i = 0; i < expected.length; i++)
      assertArrayEquals(HexFormat.of().parseHex(expected[i]), packets.get(i));
  }
  @Test
  public void normalizesOfficialKeyPrefixAndRejectsInvalidKeys() {
    List<byte[]> packets = new ArrayList<>();
    var input = new ManagedInput(packets::add);
    input.sendKey((short) 0x8041, true, (byte) 0, (byte) 0);
    input.sendKey((short) 0x0041, true, (byte) 0, (byte) 0);
    assertArrayEquals(packets.get(0), packets.get(1));
    for (int invalid : new int[] {0, 0x8000, 0x0100, 0x8141, 0xffff}) {
      input.sendKey((short) invalid, true, (byte) 0, (byte) 0);
    }
    assertEquals(2, packets.size());
  }
  @Test
  public void relativeAsAbsoluteAccumulatesAndClamps() {
    List<byte[]> packets = new ArrayList<>();
    var pointer = new ManagedInput(packets::add);
    pointer.sendMouseMoveAsMousePosition((short) 10, (short) -20, (short) 100, (short) 80);
    pointer.sendMouseMoveAsMousePosition((short) 1000, (short) -1000, (short) 100, (short) 80);
    assertArrayEquals(
        HexFormat.of().parseHex("060212000000000e05000000003c0014000000640050"), packets.get(0));
    assertArrayEquals(
        HexFormat.of().parseHex("060212000000000e0500000000640000000000640050"), packets.get(1));
  }
}
