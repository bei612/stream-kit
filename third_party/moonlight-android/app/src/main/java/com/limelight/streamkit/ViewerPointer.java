package com.limelight.streamkit;

import android.os.Build;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import com.limelight.binding.input.touch.AbsoluteTouchContext;
import com.limelight.binding.input.touch.RelativeTouchContext;
import com.limelight.binding.input.touch.TouchContext;
import com.limelight.nvstream.input.PointerInput;
import com.limelight.preferences.PreferenceConfiguration;
import java.util.function.BooleanSupplier;

/** One input owner for native touch gestures, physical mice and the local cursor. */
final class ViewerPointer implements View.OnTouchListener, View.OnGenericMotionListener {
  private final ManagedInput input;
  private final View video;
  private final ViewerCursor cursor;
  private final BooleanSupplier authorized;
  private final ViewerSettings settings;
  private TouchContext[] fingers;
  private final int[] pointerIds = {-1, -1};
  private int width = 1920, height = 1080, buttons;
  private float sensitivity = 1, cursorX = .5f, cursorY = .5f, lastX, lastY, scrollX, scrollY;
  private boolean mousePositionKnown, localCursor;
  private int gestureGeneration;

  ViewerPointer(ManagedInput input, View video, ViewerCursor cursor, ViewerSettings settings,
      BooleanSupplier authorized) {
    this.input = input;
    this.video = video;
    this.cursor = cursor;
    this.settings = settings;
    this.authorized = authorized;
    configure();
  }
  void dimensions(int width, int height) {
    if (width > 0 && height > 0 && (this.width != width || this.height != height)) {
      this.width = width;
      this.height = height;
      configure();
    }
  }
  void configure() {
    cancel();
    sensitivity = (float) Math.max(.1, Math.min(5, settings.decimal("localCursorSensitivity", 1)));
    String mode = settings.text("touchMode", "mouseRelative");
    boolean relative = mode.equals("mouseRelative") || mode.equals("localCursor");
    PreferenceConfiguration preferences = new PreferenceConfiguration();
    preferences.absoluteMouseMode = mode.equals("localCursor");
    // An old gesture's deferred tap-up must never affect a later session/gesture owner.
    final int generation = gestureGeneration;
    PointerInput gestures = new PointerInput() {
      private boolean allowed() {
        return authorized.getAsBoolean() && generation == gestureGeneration;
      }
      public void sendMouseMove(short x, short y) {
        if (allowed())
          input.sendMouseMove(x, y);
      }
      public void sendMousePosition(short x, short y, short w, short h) {
        if (allowed())
          input.sendMousePosition(x, y, w, h);
      }
      public void sendMouseMoveAsMousePosition(short x, short y, short w, short h) {
        if (allowed())
          moveCursor(x / (float) width, y / (float) height);
      }
      public void sendMouseButtonDown(byte button) {
        if (allowed()) {
          if (preferences.absoluteMouseMode)
            sendCursor();
          input.sendMouseButtonDown(button);
        }
      }
      public void sendMouseButtonUp(byte button) {
        if (allowed())
          input.sendMouseButtonUp(button);
      }
      public void sendMouseHighResScroll(short amount) {
        if (allowed())
          scroll(0, amount);
      }
    };
    fingers = new TouchContext[2];
    for (int i = 0; i < fingers.length; i++)
      fingers[i] = relative
          ? new RelativeTouchContext(gestures, i, width, height, video, preferences)
          : new AbsoluteTouchContext(gestures, i, video);
  }
  void cancel() {
    if (fingers != null)
      for (TouchContext finger : fingers) finger.cancelTouch();
    if (authorized.getAsBoolean()) {
      input.sendTouch(7, 0, 0, 0, 0);
      // Also release delayed tap buttons owned by the gesture recognizers.
      for (byte button = 1; button <= 5; button++) input.sendMouseButtonUp(button);
    }
    gestureGeneration++;
    fingers = null;
    buttons = 0;
    pointerIds[0] = pointerIds[1] = -1;
    mousePositionKnown = false;
    scrollX = scrollY = 0;
    cursor.position(cursorX, cursorY, false);
  }
  @Override
  public boolean onTouch(View view, MotionEvent event) {
    if (!authorized.getAsBoolean()) {
      cancel();
      return true;
    }
    if (event.isFromSource(InputDevice.SOURCE_MOUSE))
      return mouse(event);
    int action = event.getActionMasked(), index = event.getActionIndex();
    localCursor = settings.text("touchMode", "mouseRelative").equals("localCursor");
    cursor.position(cursorX, cursorY, localCursor);
    if (settings.text("touchMode", "mouseRelative").equals("touch")) {
      if (action == MotionEvent.ACTION_CANCEL) {
        input.sendTouch(7, 0, 0, 0, 0);
        return true;
      }
      if (action != MotionEvent.ACTION_DOWN && action != MotionEvent.ACTION_POINTER_DOWN
          && action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_POINTER_UP
          && action != MotionEvent.ACTION_MOVE)
        return true;
      for (int i = 0; i < event.getPointerCount(); i++) {
        if (action != MotionEvent.ACTION_MOVE && i != index)
          continue;
        int type = action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN
            ? 1
            : action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP ? 2
                                                                                         : 3;
        input.sendTouch(type, event.getPointerId(i), event.getX(i) / Math.max(1, video.getWidth()),
            event.getY(i) / Math.max(1, video.getHeight()), event.getPressure(i));
      }
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      cancel();
      return true;
    }
    if (action == MotionEvent.ACTION_DOWN || fingers == null)
      configure();
    if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
      for (int slot = 0; slot < pointerIds.length; slot++)
        if (pointerIds[slot] < 0) {
          pointerIds[slot] = event.getPointerId(index);
          break;
        }
    }
    for (TouchContext finger : fingers) finger.setPointerCount(event.getPointerCount());
    for (int slot = 0; slot < fingers.length; slot++) {
      int i = event.findPointerIndex(pointerIds[slot]);
      if (i < 0)
        continue;
      TouchContext finger = fingers[slot];
      if (action == MotionEvent.ACTION_MOVE)
        finger.touchMoveEvent((int) event.getX(i), (int) event.getY(i), event.getEventTime());
      else if (i == index
          && (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN))
        finger.touchDownEvent((int) event.getX(i), (int) event.getY(i), event.getEventTime(), true);
      else if (i == index
          && (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP)) {
        finger.touchUpEvent((int) event.getX(i), (int) event.getY(i), event.getEventTime());
        pointerIds[slot] = -1;
      }
    }
    if (action == MotionEvent.ACTION_UP)
      view.performClick();
    return true;
  }
  @Override
  public boolean onGenericMotion(View view, MotionEvent event) {
    if (!authorized.getAsBoolean() || !event.isFromSource(InputDevice.SOURCE_MOUSE))
      return false;
    return mouse(event);
  }
  boolean captured(MotionEvent event) {
    if (!authorized.getAsBoolean())
      return true;
    if (event.getActionMasked() == MotionEvent.ACTION_SCROLL)
      return wheel(event);
    if (event.getActionMasked() == MotionEvent.ACTION_MOVE)
      input.sendMouseMove(delta(event.getX()), delta(event.getY()));
    return mouseButtons(event);
  }
  private boolean mouse(MotionEvent event) {
    if (event.getActionMasked() == MotionEvent.ACTION_SCROLL)
      return wheel(event);
    if (Build.VERSION.SDK_INT >= 26 && video.hasPointerCapture())
      return captured(event);
    String mode = settings.text("mouseMode", "follow");
    localCursor = mode.equals("localCursor");
    cursor.position(cursorX, cursorY, localCursor);
    float dx = mousePositionKnown ? event.getX() - lastX : 0,
          dy = mousePositionKnown ? event.getY() - lastY : 0;
    lastX = event.getX();
    lastY = event.getY();
    mousePositionKnown = true;
    int next = event.getButtonState();
    boolean down = (next & ~buttons) != 0;
    if (mode.equals("relative")) {
      if (Build.VERSION.SDK_INT >= 26) {
        video.requestFocus();
        video.requestPointerCapture();
      } else
        input.sendMouseMove(delta(dx * width / Math.max(1, video.getWidth())),
            delta(dy * height / Math.max(1, video.getHeight())));
    } else if (localCursor) {
      moveCursor(dx / Math.max(1, video.getWidth()), dy / Math.max(1, video.getHeight()));
      if (down)
        sendCursor();
    } else if (mode.equals("pointAndDrag")) {
      if (down)
        position(event);
      else if (next != 0)
        input.sendMouseMove(delta(dx * width / Math.max(1, video.getWidth())),
            delta(dy * height / Math.max(1, video.getHeight())));
    } else
      position(event);
    return mouseButtons(event);
  }
  private void position(MotionEvent event) {
    input.sendMousePosition(
        (short) Math.max(0, Math.min(4096, event.getX() * 4096 / Math.max(1, video.getWidth()))),
        (short) Math.max(0, Math.min(4096, event.getY() * 4096 / Math.max(1, video.getHeight()))),
        (short) 4096, (short) 4096);
  }
  private void moveCursor(float dx, float dy) {
    cursorX = Math.max(0, Math.min(1, cursorX + dx * sensitivity));
    cursorY = Math.max(0, Math.min(1, cursorY + dy * sensitivity));
    cursor.position(cursorX, cursorY, true);
    sendCursor();
  }
  private void sendCursor() {
    input.sendMousePosition(
        (short) (cursorX * 4096), (short) (cursorY * 4096), (short) 4096, (short) 4096);
  }
  private boolean wheel(MotionEvent event) {
    scroll(event.getAxisValue(MotionEvent.AXIS_HSCROLL) * 120,
        event.getAxisValue(MotionEvent.AXIS_VSCROLL) * 120);
    return true;
  }
  private void scroll(float x, float y) {
    scrollX += x;
    scrollY += y;
    int step = settings.text("mouseScrollMode", "highres").equals("normal") ? 120 : 1;
    short sx = (short) Math.max(-32760, Math.min(32760, ((int) (scrollX / step)) * step));
    short sy = (short) Math.max(-32760, Math.min(32760, ((int) (scrollY / step)) * step));
    if (sx != 0) {
      input.sendMouseHorizontalScroll(sx);
      scrollX -= sx;
    }
    if (sy != 0) {
      input.sendMouseHighResScroll(sy);
      scrollY -= sy;
    }
  }
  private short delta(float value) {
    return (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(value)));
  }
  private boolean mouseButtons(MotionEvent event) {
    int next = event.getButtonState();
    for (int mask : new int[] {1, 2, 4, 8, 16})
      if ((buttons & mask) != (next & mask)) {
        if ((next & mask) != 0)
          input.sendMouseButtonDown(mouseButton(mask));
        else
          input.sendMouseButtonUp(mouseButton(mask));
      }
    buttons = next;
    return true;
  }
  private static byte mouseButton(int mask) {
    return (byte) (mask == 1 ? 1 : mask == 2 ? 3 : mask == 4 ? 2 : mask == 8 ? 4 : 5);
  }
}
