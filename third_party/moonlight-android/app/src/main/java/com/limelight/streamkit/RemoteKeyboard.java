package com.limelight.streamkit;

import android.content.Context;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;

/** IME commits (including CJK composition) enter the existing managed text protocol. */
final class RemoteKeyboard extends View {
  interface Output {
    void text(String value);
    void key(int virtualKey);
  }
  private final Output output;
  RemoteKeyboard(Context context, Output output) {
    super(context);
    this.output = output;
    setFocusable(true);
    setFocusableInTouchMode(true);
    setSaveEnabled(false);
    setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
  }
  @Override
  public boolean onCheckIsTextEditor() {
    return true;
  }
  @Override
  public InputConnection onCreateInputConnection(EditorInfo info) {
    info.inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
        | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
    info.imeOptions =
        EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
    return new BaseInputConnection(this, true) {
      @Override
      public boolean commitText(CharSequence text, int cursor) {
        output.text(text.toString());
        getEditable().clear();
        return true;
      }
      @Override
      public boolean deleteSurroundingText(int before, int after) {
        for (int i = 0; i < Math.min(before, 128); i++) output.key(0x08);
        for (int i = 0; i < Math.min(after, 128); i++) output.key(0x2e);
        return true;
      }
      @Override
      public boolean sendKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
          if (event.getKeyCode() == KeyEvent.KEYCODE_DEL)
            output.key(0x08);
          else if (event.getKeyCode() == KeyEvent.KEYCODE_ENTER)
            output.key(0x0d);
          else
            return RemoteKeyboard.this.dispatchKeyEvent(event);
        }
        return true;
      }
      @Override
      public boolean performEditorAction(int action) {
        output.key(0x0d);
        return true;
      }
    };
  }
  void showKeyboard() {
    requestFocus();
    ((InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE))
        .showSoftInput(this, InputMethodManager.SHOW_IMPLICIT);
  }
  void hideKeyboard() {
    ((InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE))
        .hideSoftInputFromWindow(getWindowToken(), 0);
    clearFocus();
  }
}
