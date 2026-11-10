package io.github.bei612.streamkit.focusobserver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import java.io.FileDescriptor;
import java.io.PrintWriter;

/** External testOnly focus owner. No microphone, network, PCM or product hooks. */
public final class FocusService extends Service implements AudioManager.OnAudioFocusChangeListener {
    private AudioManager manager;
    private AudioFocusRequest request;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable expiry = new Runnable() {
        @Override public void run() { stopSelf(); }
    };
    private volatile int result = AudioManager.AUDIOFOCUS_REQUEST_FAILED;
    private volatile int lastChange;
    private volatile int changes;
    private volatile long requestedAt;

    @Override public void onCreate() {
        super.onCreate();
        // API 35+ requires a foreground app/service for a normal focus request.
        // Use the actual public API and manifest service type, with no test
        // identity override or hidden audio-policy interface.
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(
                "focus-acceptance", "Audio focus acceptance", NotificationManager.IMPORTANCE_LOW));
        Notification notification = new Notification.Builder(this, "focus-acceptance")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("Stream Kit test audio focus")
                .setContentText("Temporary test-only focus owner; expires automatically")
                .build();
        startForeground(1, notification);
        manager = getSystemService(AudioManager.class);
        request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(this, handler).build();
        requestedAt = SystemClock.elapsedRealtime();
        result = manager.requestAudioFocus(request);
        handler.postDelayed(expiry, 60000);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override public void onAudioFocusChange(int change) {
        lastChange = change;
        changes++;
    }

    @Override protected void dump(FileDescriptor fd, PrintWriter writer, String[] args) {
        writer.println("STREAM_KIT_FOCUS_OBSERVER result=" + result
                + " requested_elapsed_ms=" + requestedAt + " changes=" + changes
                + " last_change=" + lastChange);
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(expiry);
        if (request != null && manager != null) manager.abandonAudioFocusRequest(request);
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
