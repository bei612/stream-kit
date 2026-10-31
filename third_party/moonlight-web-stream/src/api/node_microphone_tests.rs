use super::*;
use std::sync::Arc;
use stream_kit_audio_target::{
    FRAME_SAMPLES,
    admission::Binding,
    wire::{self, Generation},
};

struct Device(mpsc::Sender<&'static str>);
impl Output for Device {
    fn clear(&self) {
        let _ = self.0.send("clear");
    }
    fn submit_captured(&self, _: &[f32], _: Instant) -> bool {
        let _ = self.0.send("write");
        true
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        let _ = self.0.send("drop");
    }
}

#[test]
fn receiver_worker_writes_then_releases_on_idle_revocation_disconnect_or_bad_frame() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/audio-devices/remote-microphone-v1.fixture.json"
    ))
    .expect("admission fixture");
    let binding: Binding = serde_json::from_value(fixture["claims"].clone()).expect("binding");
    let key = node_key(
        fixture["root_secret"].as_str().expect("root").as_bytes(),
        &binding.target_node_id,
    )
    .expect("node key");
    for mode in ["idle-revoke", "disconnect", "bad-frame"] {
        let admitted = Admissions::new(1)
            .admit(
                fixture["token"].as_str().expect("token"),
                &key,
                &binding,
                fixture["now"].as_i64().expect("time"),
            )
            .expect("admission");
        let mut envelope: crate::app::node_audio::Envelope = serde_json::from_str(include_str!(
            "../../../../contracts/audio-devices/node-state-v1.fixture.json"
        ))
        .expect("state fixture");
        let now = now_ms();
        envelope.instance_id = binding.target_instance_id.clone();
        envelope.state.issued_at_ms = now;
        envelope.state.expires_at_ms = now + 10000;
        let session = &mut envelope.state.sessions[0];
        session.session_id = binding.session_id.clone();
        session.host_id = binding.host_id;
        session.app_id = binding.app_id;
        session.control_epoch = binding.control_epoch;
        session.controller_connection_id = binding.connection_id.clone();
        session.connections.truncate(1);
        session.connections[0].connection_id = binding.connection_id.clone();
        session.connections[0].expires_at_ms = now + 10000;
        envelope.bindings = vec![binding.clone()];
        let state = Arc::new(RwLock::new(Authority::default()));
        state
            .blocking_write()
            .apply(envelope, &binding.target_instance_id, now, Instant::now())
            .expect("live grant");
        let (events, observed) = mpsc::channel();
        let (sender, frames) = mpsc::sync_channel(1);
        let worker_state = state.clone();
        let session_id = binding.session_id.clone();
        let worker = std::thread::spawn(move || {
            run_output(
                RemoteOutput::new(admitted, Device(events)),
                &worker_state,
                &session_id,
                frames,
            )
        });
        let mut bytes = [0; FRAME_BYTES];
        let received = Instant::now();
        let unix_ms = now_ms() as u64;
        wire::encode(
            Generation {
                target: binding.target_epoch,
                controller: binding.control_epoch,
            },
            1,
            unix_ms,
            &[0.1; FRAME_SAMPLES],
            &mut bytes,
        )
        .expect("frame");
        sender
            .send(Frame {
                bytes: bytes.to_vec().into(),
                unix_ms,
                received,
            })
            .expect("send");
        assert_eq!(
            observed
                .recv_timeout(Duration::from_secs(2))
                .expect("write"),
            "write"
        );
        match mode {
            "idle-revoke" => {
                *state.blocking_write() = Authority::default();
            }
            "bad-frame" => {
                sender
                    .send(Frame {
                        bytes: vec![0; FRAME_BYTES].into(),
                        unix_ms: now_ms() as u64,
                        received: Instant::now(),
                    })
                    .expect("bad frame");
            }
            _ => {
                drop(sender);
            }
        }
        assert_eq!(
            observed
                .recv_timeout(Duration::from_secs(2))
                .expect("clear"),
            "clear"
        );
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(2)).expect("drop"),
            "drop"
        );
        worker.join().expect("receiver worker");
    }
}
