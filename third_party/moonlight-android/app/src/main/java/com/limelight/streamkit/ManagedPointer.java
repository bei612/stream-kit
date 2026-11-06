package com.limelight.streamkit;

import com.limelight.nvstream.input.PointerInput;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Existing gateway control-packet format (Sunshine 7, input_data 0x0206). */
final class ManagedPointer implements PointerInput {
    interface Sink { void send(byte[] packet); }
    private final Sink sink;
    private int virtualX = -1, virtualY = -1;
    ManagedPointer(Sink sink) { this.sink = sink; }
    private static ByteBuffer packet(int type, int payloadSize) {
        int inputSize = 4 + payloadSize;
        ByteBuffer data = ByteBuffer.allocate(8 + inputSize).order(ByteOrder.LITTLE_ENDIAN);
        data.putShort((short) 0x0206).putShort((short) (4 + inputSize));
        data.order(ByteOrder.BIG_ENDIAN).putInt(inputSize);
        data.order(ByteOrder.LITTLE_ENDIAN).putInt(type);
        return data.order(ByteOrder.BIG_ENDIAN);
    }
    @Override public void sendMouseMove(short x, short y) { sink.send(packet(7, 4).putShort(x).putShort(y).array()); }
    @Override public void sendMousePosition(short x, short y, short width, short height) {
        sink.send(packet(5, 10).putShort(x).putShort(y).putShort((short) 0).putShort(width).putShort(height).array());
    }
    @Override public void sendMouseMoveAsMousePosition(short x, short y, short width, short height) {
        int w = Short.toUnsignedInt(width), h = Short.toUnsignedInt(height);
        if (w == 0 || h == 0) return;
        if (virtualX < 0) { virtualX = w / 2; virtualY = h / 2; }
        virtualX = Math.max(0, Math.min(w, virtualX + x));
        virtualY = Math.max(0, Math.min(h, virtualY + y));
        sendMousePosition((short) virtualX, (short) virtualY, width, height);
    }
    @Override public void sendMouseButtonDown(byte button) { sink.send(packet(8, 1).put(button).array()); }
    @Override public void sendMouseButtonUp(byte button) { sink.send(packet(9, 1).put(button).array()); }
    @Override public void sendMouseHighResScroll(short amount) {
        sink.send(packet(10, 6).putShort(amount).putShort(amount).putShort((short) 0).array());
    }
}
