package com.limelight.streamkit;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnectionFactory;

/** Separate test APK: exercise the minified release's JNI ABI without recording audio. */
public final class NativeLibrarySmoke extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        PeerConnectionFactory factory = null;
        int code = Activity.RESULT_CANCELED;
        try {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                    .builder(getTargetContext()).createInitializationOptions());
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
            if (factory.getRtpReceiverCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO).codecs.isEmpty()) {
                throw new IllegalStateException("No native audio codec capabilities");
            }
            result.putString("stream_kit_native_smoke", "passed");
            code = Activity.RESULT_OK;
        } catch (Throwable error) {
            result.putString("stream_kit_native_smoke", "failed");
            result.putString("failure_class", error.getClass().getName());
        } finally { if (factory != null) factory.dispose(); }
        finish(code, result);
    }
}
