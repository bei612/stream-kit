package com.limelight.streamkit;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/** Composited above the native video surface; never intercepts input. */
final class ViewerCursor extends View {
  private final View video;
  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Path arrow = new Path();
  private float x = .5f, y = .5f;
  ViewerCursor(Context context, View video) {
    super(context);
    this.video = video;
    setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    setVisibility(INVISIBLE);
  }
  void position(float x, float y, boolean visible) {
    this.x = x;
    this.y = y;
    setVisibility(visible ? VISIBLE : INVISIBLE);
    invalidate();
  }
  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    canvas.save();
    canvas.translate(
        video.getLeft() + x * video.getWidth(), video.getTop() + y * video.getHeight());
    float scale = getResources().getDisplayMetrics().density;
    canvas.scale(scale, scale);
    arrow.reset();
    arrow.moveTo(0, 0);
    arrow.lineTo(0, 21);
    arrow.lineTo(5, 16);
    arrow.lineTo(10, 25);
    arrow.lineTo(14, 23);
    arrow.lineTo(9, 14);
    arrow.lineTo(17, 14);
    arrow.close();
    paint.setStyle(Paint.Style.FILL);
    paint.setColor(Color.WHITE);
    canvas.drawPath(arrow, paint);
    paint.setStyle(Paint.Style.STROKE);
    paint.setColor(Color.BLACK);
    paint.setStrokeWidth(1.5f);
    canvas.drawPath(arrow, paint);
    canvas.restore();
  }
}
