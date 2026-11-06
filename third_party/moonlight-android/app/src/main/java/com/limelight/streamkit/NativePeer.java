package com.limelight.streamkit;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import com.limelight.nvstream.StreamConfiguration;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native WebRTC media peer. Public lifecycle methods are owned by the main looper. */
public final class NativePeer implements AutoCloseable {
    public interface Listener {
        void offerReady(String sdp);
        void connected();
        void failed(String reason);
        void microphoneState(boolean live);
        void frameReceived();
    }
    private static boolean initialized;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AuthorityState authority;
    private final Listener listener;
    private final VideoSink videoSink;
    private final VideoSink guardedSink;
    private final JavaAudioDeviceModule audio;
    private final PeerConnectionFactory factory;
    private final PeerConnection peer;
    private final DataChannel negotiationChannel;
    private final RtpSender microphoneSender;
    private DataChannel controlChannel;
    private VideoTrack receivedVideo;
    private AudioTrack microphoneTrack;
    private AudioSource microphoneSource;
    private volatile boolean closed;
    private boolean offerSent;
    private String offerAttributes;

    public NativePeer(Context context, EglBase.Context egl, VideoSink sink,
                      List<PeerConnection.IceServer> iceServers, AuthorityState authority, Listener listener) {
        requireMain();
        this.context = context.getApplicationContext();
        this.authority = authority;
        this.listener = listener;
        this.videoSink = sink;
        AtomicBoolean firstFrame = new AtomicBoolean();
        this.guardedSink = frame -> {
            if (closed) return;
            videoSink.onFrame(frame);
            if (firstFrame.compareAndSet(false, true)) post(listener::frameReceived);
        };
        synchronized (NativePeer.class) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                        .builder(this.context).createInitializationOptions());
                initialized = true;
            }
        }
        audio = JavaAudioDeviceModule.builder(this.context)
                .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                    @Override public void onWebRtcAudioRecordInitError(String error) { recordingFailed(); }
                    @Override public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code, String error) { recordingFailed(); }
                    @Override public void onWebRtcAudioRecordError(String error) { recordingFailed(); }
                    private void recordingFailed() {
                        post(() -> {
                            authority.muteMicrophone();
                            setMicrophone(false);
                            listener.microphoneState(false);
                        });
                    }
                })
                .setAudioRecordStateCallback(new JavaAudioDeviceModule.AudioRecordStateCallback() {
                    @Override public void onWebRtcAudioRecordStart() {
                        post(() -> {
                            if (!authority.canSendMicrophone()) { setMicrophone(false); return; }
                            listener.microphoneState(true);
                        });
                    }
                    @Override public void onWebRtcAudioRecordStop() { post(() -> listener.microphoneState(false)); }
                }).createAudioDeviceModule();
        audio.setAudioRecordEnabled(false);
        factory = PeerConnectionFactory.builder().setAudioDeviceModule(audio)
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl))
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl, true, true))
                .createPeerConnectionFactory();
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        PeerConnection connection = factory.createPeerConnection(config, new Observer());
        if (connection == null) {
            factory.dispose();
            audio.release();
            throw new IllegalStateException("Unable to create native media peer");
        }
        peer = connection;
        peer.setAudioRecording(false);
        peer.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY));
        peer.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY));
        microphoneSender = peer.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)).getSender();
        // Creates the SCTP section. The gateway opens moonlight.control in the negotiated association.
        negotiationChannel = peer.createDataChannel("dummy", new DataChannel.Init());
    }

    public void createOffer(long hostId, long appId, StreamConfiguration settings) {
        requireMain();
        if (closed || hostId < 1 || appId < 1 || hostId > 0xffffffffL || appId > 0xffffffffL) {
            throw new IllegalArgumentException("Invalid rendering application");
        }
        if (settings == null || settings.getWidth() < 1 || settings.getHeight() < 1 ||
                settings.getRefreshRate() < 1 || settings.getBitrate() < 1) {
            throw new IllegalArgumentException("Invalid media settings");
        }
        // Snapshot the existing Moonlight settings model before asynchronous negotiation.
        offerAttributes = "a=x-moonlight-host-id:" + hostId + "\r\n" +
                "a=x-moonlight-app-id:" + appId + "\r\n" +
                "a=x-moonlight-mode:" + settings.getWidth() + "x" + settings.getHeight() + "x" + settings.getRefreshRate() + "\r\n" +
                "a=x-moonlight-bitrate:" + settings.getBitrate() + "\r\n" +
                "a=x-moonlight-hdr:0\r\n" +
                "a=x-moonlight-local-audio-play-mode:" + (settings.getPlayLocalAudio() ? "1" : "0") + "\r\n";
        peer.createOffer(new SdpCallbacks() {
            @Override public void onCreateSuccess(SessionDescription description) {
                post(() -> peer.setLocalDescription(new SdpCallbacks() {
                    @Override public void onSetSuccess() { post(NativePeer.this::sendGatheredOffer); }
                }, description));
            }
        }, new MediaConstraints());
        main.postDelayed(() -> {
            if (!closed && !offerSent) listener.failed("ICE_GATHERING_TIMEOUT");
        }, 12000);
    }

    private void sendGatheredOffer() {
        if (closed || offerSent || peer.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return;
        SessionDescription local = peer.getLocalDescription();
        if (local == null) return;
        String sdp = local.description;
        int media = sdp.indexOf("m=");
        if (media < 0) { listener.failed("INVALID_LOCAL_SDP"); return; }
        offerSent = true;
        listener.offerReady(sdp.substring(0, media) + offerAttributes + sdp.substring(media));
    }

    public void answer(String sdp) {
        requireMain();
        if (!closed) peer.setRemoteDescription(new SdpCallbacks(),
                new SessionDescription(SessionDescription.Type.ANSWER, sdp));
    }

    public boolean setMicrophone(boolean enabled) {
        requireMain();
        if (closed) return false;
        boolean granted = Build.VERSION.SDK_INT < 23 ||
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean allowed = enabled && granted && authority.canSendMicrophone();
        if (!allowed) {
            // Stop hardware recording as well as detaching the RTP sender.
            peer.setAudioRecording(false);
            audio.setAudioRecordEnabled(false);
            audio.requestStopRecording();
            microphoneSender.setTrack(null, false);
            if (microphoneTrack != null) { microphoneTrack.setEnabled(false); microphoneTrack.dispose(); microphoneTrack = null; }
            if (microphoneSource != null) { microphoneSource.dispose(); microphoneSource = null; }
            return false;
        }
        if (microphoneTrack == null) {
            microphoneSource = factory.createAudioSource(new MediaConstraints());
            microphoneTrack = factory.createAudioTrack("streamkit-microphone", microphoneSource);
            if (!microphoneSender.setTrack(microphoneTrack, false)) {
                setMicrophone(false);
                listener.failed("MICROPHONE_TRACK_REJECTED");
                return false;
            }
        }
        audio.setAudioRecordEnabled(true);
        peer.setAudioRecording(true);
        return true;
    }

    public boolean sendControl(byte[] packet) {
        requireMain();
        if (closed || !authority.canSendInput() || controlChannel == null ||
                controlChannel.state() != DataChannel.State.OPEN || controlChannel.bufferedAmount() > 65536) return false;
        return controlChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(packet), true));
    }

    public void audible(boolean enabled) { requireMain(); if (!closed) peer.setAudioPlayout(enabled); }

    @Override public void close() {
        requireMain();
        if (closed) return;
        setMicrophone(false);
        closed = true;
        if (receivedVideo != null) { receivedVideo.removeSink(guardedSink); receivedVideo = null; }
        if (controlChannel != null) { controlChannel.close(); controlChannel.dispose(); controlChannel = null; }
        negotiationChannel.close();
        negotiationChannel.dispose();
        peer.close();
        peer.dispose();
        factory.dispose();
        audio.release();
    }

    private void post(Runnable action) { main.post(() -> { if (!closed) action.run(); }); }
    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Media lifecycle must use the main looper");
    }

    private class SdpCallbacks implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) { }
        @Override public void onSetSuccess() { }
        @Override public void onCreateFailure(String error) { post(() -> listener.failed("SDP_CREATE_FAILED")); }
        @Override public void onSetFailure(String error) { post(() -> listener.failed("SDP_APPLY_FAILED")); }
    }

    private class Observer implements PeerConnection.Observer {
        @Override public void onSignalingChange(PeerConnection.SignalingState state) { }
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { }
        @Override public void onIceConnectionReceivingChange(boolean receiving) { }
        @Override public void onIceCandidate(IceCandidate candidate) { }
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) { }
        @Override public void onAddStream(MediaStream stream) { }
        @Override public void onRemoveStream(MediaStream stream) { }
        @Override public void onRenegotiationNeeded() { }
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) post(NativePeer.this::sendGatheredOffer);
        }
        @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) {
            post(() -> {
                if (state == PeerConnection.PeerConnectionState.CONNECTED) listener.connected();
                else if (state == PeerConnection.PeerConnectionState.FAILED || state == PeerConnection.PeerConnectionState.DISCONNECTED)
                    listener.failed("MEDIA_DISCONNECTED");
            });
        }
        @Override public void onDataChannel(DataChannel channel) {
            main.post(() -> {
                if (!closed && "moonlight.control".equals(channel.label()) && controlChannel == null) controlChannel = channel;
                else { channel.close(); channel.dispose(); }
            });
        }
        @Override public void onTrack(RtpTransceiver transceiver) {
            post(() -> {
                MediaStreamTrack track = transceiver.getReceiver().track();
                if (track instanceof VideoTrack) {
                    if (receivedVideo != null) receivedVideo.removeSink(guardedSink);
                    receivedVideo = (VideoTrack) track;
                    receivedVideo.addSink(guardedSink);
                } else if (track instanceof AudioTrack) track.setEnabled(true);
            });
        }
    }
}
