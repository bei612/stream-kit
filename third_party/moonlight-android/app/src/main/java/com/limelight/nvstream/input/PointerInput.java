package com.limelight.nvstream.input;

/** Transport-independent sink for Moonlight's native absolute/relative touch gestures. */
public interface PointerInput {
    void sendMouseMove(short deltaX, short deltaY);
    void sendMousePosition(short x, short y, short referenceWidth, short referenceHeight);
    void sendMouseMoveAsMousePosition(short deltaX, short deltaY, short referenceWidth, short referenceHeight);
    void sendMouseButtonDown(byte mouseButton);
    void sendMouseButtonUp(byte mouseButton);
    void sendMouseHighResScroll(short scrollAmount);
}
