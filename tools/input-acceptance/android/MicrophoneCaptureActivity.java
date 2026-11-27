package io.github.bei612.streamkit.inputobserver;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.widget.TextView;

import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Foreground recording by the standalone testOnly app. No PCM leaves this process. */
public final class MicrophoneCaptureActivity extends Activity {
    private static final int RATE = 48000;
    private static final int TARGET_HZ = 1499;
    private static final int WINDOW = RATE / 10;
    private static final int WINDOWS = 50;

    private final CountDownLatch foreground = new CountDownLatch(1);
    private final CountDownLatch stopped = new CountDownLatch(1);

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView status = new TextView(this);
        status.setText("Stream Kit CI microphone control");
        setContentView(status);
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) foreground.countDown();
    }

    @Override protected void onStop() {
        super.onStop();
        stopped.countDown();
    }

    static Bundle measure(Instrumentation observer) {
        if (!"ranchu".equals(Build.HARDWARE) && !"goldfish".equals(Build.HARDWARE))
            throw new IllegalStateException("Emulator fixture required");
        Intent intent = new Intent(observer.getTargetContext(), MicrophoneCaptureActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MicrophoneCaptureActivity activity = (MicrophoneCaptureActivity) observer.startActivitySync(intent);
        try {
            if (!activity.foreground.await(3, TimeUnit.SECONDS))
                throw new IllegalStateException("Capture Activity did not reach the foreground");
            stage(observer, "activity_focused");
            Bundle measurement = capture(activity, observer);
            stage(observer, "audio_record_released");
            close(observer, activity);
            measurement.putString("mic_control_released", "true");
            return measurement;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        } finally {
            if (activity.stopped.getCount() != 0) finish(observer, activity);
        }
    }

    private static void close(Instrumentation observer, MicrophoneCaptureActivity activity) throws InterruptedException {
        finish(observer, activity);
        if (!activity.stopped.await(3, TimeUnit.SECONDS))
            throw new IllegalStateException("Capture Activity remained in the foreground");
    }

    private static void finish(Instrumentation observer, final MicrophoneCaptureActivity activity) {
        observer.runOnMainSync(new Runnable() {
            @Override public void run() { activity.finish(); }
        });
    }

    private static void stage(Instrumentation observer, String name) {
        Bundle status = new Bundle();
        status.putString("mic_control_stage", name);
        observer.sendStatus(2, status);
    }

    private static Bundle capture(MicrophoneCaptureActivity activity, Instrumentation observer) {
        if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Foreground recorder permission was not granted");
        stage(observer, "checking_input_format");
        int minimumBytes = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimumBytes <= 0) throw new IllegalStateException("Capture format unavailable");
        stage(observer, "opening_audio_record");
        AudioRecord.Builder builder = new AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(minimumBytes, WINDOW * Short.BYTES));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setContext(activity);
        AudioRecord recorder = builder.build();
        try {
            if (recorder.getSampleRate() != RATE) throw new IllegalStateException("Unexpected capture sample rate");
            stage(observer, "starting_audio_record");
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING)
                throw new IllegalStateException("Capture did not start");
            Bundle measurement = analyze(recorder, observer);
            Bundle measured = new Bundle(measurement);
            measured.putString("mic_control_stage", "analysis_complete");
            observer.sendStatus(2, measured);
            return measurement;
        } finally {
            try {
                if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) recorder.stop();
            } finally { recorder.release(); }
        }
    }

    private static Bundle analyze(AudioRecord recorder, Instrumentation observer) {
        double[] sine = new double[WINDOW], cosine = new double[WINDOW], amplitudes = new double[WINDOWS];
        for (int i = 0; i < WINDOW; i++) {
            double phase = 2.0 * Math.PI * TARGET_HZ * i / RATE;
            sine[i] = Math.sin(phase);
            cosine[i] = Math.cos(phase);
        }
        short[] buffer = new short[WINDOW / 5];
        int count = 0, index = 0, above = 0;
        double real = 0, imaginary = 0;
        boolean inputReady = false;
        long deadline = SystemClock.elapsedRealtime() + 6800;
        while (count < WINDOWS && SystemClock.elapsedRealtime() < deadline) {
            int read = recorder.read(buffer, 0, buffer.length, AudioRecord.READ_NON_BLOCKING);
            if (read < 0) throw new IllegalStateException("AudioRecord read failed");
            if (read == 0) {
                SystemClock.sleep(5);
                continue;
            }
            if (!inputReady) {
                Bundle started = new Bundle();
                started.putString("mic_control_started", "recording");
                observer.sendStatus(1, started);
                inputReady = true;
            }
            for (int i = 0; i < read && count < WINDOWS; i++) {
                double sample = buffer[i] / 32768.0;
                real += sample * cosine[index];
                imaginary += sample * sine[index];
                index++;
                if (index == WINDOW) {
                    double amplitude = 2 * Math.hypot(real, imaginary) / WINDOW;
                    if (amplitude > 0.01) above++;
                    amplitudes[count++] = amplitude;
                    real = imaginary = 0;
                    index = 0;
                    if (count == WINDOWS / 2) stage(observer, "half_frames_read");
                }
            }
        }
        if (count < WINDOWS) throw new IllegalStateException("Capture underrun");
        Arrays.sort(amplitudes);
        Bundle result = new Bundle();
        result.putInt("mic_control_frames", count * WINDOW);
        result.putInt("mic_control_windows_above", above);
        double median = (amplitudes[WINDOWS / 2 - 1] + amplitudes[WINDOWS / 2]) / 2;
        result.putInt("mic_control_amplitude_ppm", (int) Math.round(1_000_000 * median));
        AudioDeviceInfo route = recorder.getRoutedDevice();
        result.putInt("mic_control_route_type", route != null ? route.getType() : 0);
        if (Build.VERSION.SDK_INT >= 29) {
            AudioRecordingConfiguration config = recorder.getActiveRecordingConfiguration();
            result.putString("mic_control_silenced", config == null ? "unknown" : String.valueOf(config.isClientSilenced()));
        }
        return result;
    }
}
