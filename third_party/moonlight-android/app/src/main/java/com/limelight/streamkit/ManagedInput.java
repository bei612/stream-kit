package com.limelight.streamkit;

import com.limelight.nvstream.input.PointerInput;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Existing gateway control-packet format (Sunshine 7, input_data 0x0206). */
final class ManagedInput implements PointerInput {
  interface Sink {
    void send(byte[] packet);
  }
  private final Sink sink;
  private int virtualX = -1, virtualY = -1;
  ManagedInput(Sink sink) {
    this.sink = sink;
  }
  private static ByteBuffer packet(int type, int payloadSize) {
    int inputSize = 4 + payloadSize;
    ByteBuffer data = ByteBuffer.allocate(8 + inputSize).order(ByteOrder.LITTLE_ENDIAN);
    data.putShort((short) 0x0206).putShort((short) (4 + inputSize));
    data.order(ByteOrder.BIG_ENDIAN).putInt(inputSize);
    data.order(ByteOrder.LITTLE_ENDIAN).putInt(type);
    return data.order(ByteOrder.BIG_ENDIAN);
  }
  @Override
  public void sendMouseMove(short x, short y) {
    sink.send(packet(7, 4).putShort(x).putShort(y).array());
  }
  @Override
  public void sendMousePosition(short x, short y, short width, short height) {
    sink.send(packet(5, 10)
            .putShort(x)
            .putShort(y)
            .putShort((short) 0)
            .putShort(width)
            .putShort(height)
            .array());
  }
  @Override
  public void sendMouseMoveAsMousePosition(short x, short y, short width, short height) {
    int w = Short.toUnsignedInt(width), h = Short.toUnsignedInt(height);
    if (w == 0 || h == 0)
      return;
    if (virtualX < 0) {
      virtualX = w / 2;
      virtualY = h / 2;
    }
    virtualX = Math.max(0, Math.min(w, virtualX + x));
    virtualY = Math.max(0, Math.min(h, virtualY + y));
    sendMousePosition((short) virtualX, (short) virtualY, width, height);
  }
  @Override
  public void sendMouseButtonDown(byte button) {
    sink.send(packet(8, 1).put(button).array());
  }
  @Override
  public void sendMouseButtonUp(byte button) {
    sink.send(packet(9, 1).put(button).array());
  }
  @Override
  public void sendMouseHighResScroll(short amount) {
    sink.send(packet(10, 6).putShort(amount).putShort(amount).putShort((short) 0).array());
  }
  void sendMouseHorizontalScroll(short amount) {
    sink.send(packet(0x55000001, 2).putShort(amount).array());
  }
  void sendKey(short key, boolean down, byte modifiers, byte flags) {
    // Upstream KeyboardTranslator returns GFE's 0x80-prefixed virtual key.
    // The managed gateway reconciles pressed state with canonical 1..255
    // Windows virtual keys, shared with its browser client.
    int canonical = Short.toUnsignedInt(key);
    if ((canonical & 0xff00) == 0x8000)
      canonical &= 0xff;
    if (canonical < 1 || canonical > 255)
      return;
    sink.send(packet(down ? 3 : 4, 6)
            .order(ByteOrder.LITTLE_ENDIAN)
            .put(flags)
            .putShort((short) canonical)
            .put(modifiers)
            .putShort((short) 0)
            .array());
  }
  void sendText(String text) {
    // Match the Web client's 30-byte UTF-8 chunks without splitting code points.
    if (text == null)
      return;
    java.io.ByteArrayOutputStream chunk = new java.io.ByteArrayOutputStream(30);
    for (int offset = 0; offset < text.length();) {
      int code = text.codePointAt(offset);
      offset += Character.charCount(code);
      byte[] bytes = new String(Character.toChars(code)).getBytes(StandardCharsets.UTF_8);
      if (chunk.size() + bytes.length > 30) {
        sendTextChunk(chunk.toByteArray());
        chunk.reset();
      }
      chunk.write(bytes, 0, bytes.length);
    }
    if (chunk.size() > 0)
      sendTextChunk(chunk.toByteArray());
  }
  private void sendTextChunk(byte[] text) {
    sink.send(packet(0x17, text.length).put(text).array());
  }
  void sendTouch(int event, int pointer, float x, float y, float pressure) {
    if (Float.isNaN(x) || Float.isInfinite(x) || Float.isNaN(y) || Float.isInfinite(y)
        || Float.isNaN(pressure) || Float.isInfinite(pressure))
      return;
    sink.send(packet(0x55000002, 28)
            .order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) event)
            .put((byte) 0)
            .putShort((short) 0)
            .putInt(pointer)
            .putFloat(Math.max(0, Math.min(1, x)))
            .putFloat(Math.max(0, Math.min(1, y)))
            .putFloat(Math.max(0, Math.min(1, pressure)))
            .putFloat(0)
            .putFloat(0)
            .array());
  }
}
