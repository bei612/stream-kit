//! Observations describe runtime resources, never proof of target recording.
use serde::Serialize;
use stream_kit_audio_target::TargetStatus;

pub const SIGNING_CONTEXT: &[u8] = b"stream-kit/media-observation/v2\n";

#[derive(Debug, Serialize)]
pub struct Acknowledgement {
    pub schema_version: u32,
    pub state_issued_at_ms: i64,
    pub observed_at_ms: i64,
    pub sessions: Vec<SessionObservation>,
}

#[derive(Debug, Serialize)]
pub struct SessionObservation {
    pub session_id: String,
    pub revision: u64,
    pub upstream_active: bool,
    /// Media subscribers, not the number of admitted or ICE-connected browsers.
    pub subscribers: usize,
    pub microphone_target: TargetObservation,
}

#[derive(Debug, Serialize)]
pub struct TargetObservation {
    pub epoch: u64,
    pub state: TargetState,
    pub device: Option<TargetStatus>,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetState {
    Pending,
    Disabled,
    Unconfigured,
    Idle,
    DeviceOpen,
    DeviceFailed,
    UpstreamTransport,
    RemoteTransport,
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    #[test]
    fn serialized_observation_matches_go_contract_and_signature() {
        let ack = Acknowledgement {
            schema_version: 2,
            state_issued_at_ms: 1700000000000,
            observed_at_ms: 1700000000010,
            sessions: vec![SessionObservation {
                session_id: "session-test".into(),
                revision: 7,
                upstream_active: true,
                subscribers: 2,
                microphone_target: TargetObservation {
                    epoch: 3,
                    state: TargetState::DeviceOpen,
                    error: None,
                    device: Some(TargetStatus {
                        device_open: true,
                        device_sample_frames: 48000,
                        dropped_frames: 0,
                        xruns: 0,
                        realtime_denied: false,
                        error: None,
                    }),
                },
            }],
        };
        let body = serde_json::to_string(&ack)
            .expect("observation fixture serialization or signing failed");
        assert_eq!(
            body,
            include_str!("../../../../contracts/media-state/v2.observation.fixture.json").trim()
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(b"contract-test-secret")
            .expect("observation fixture serialization or signing failed");
        mac.update(SIGNING_CONTEXT);
        mac.update(body.as_bytes());
        assert_eq!(
            hex::encode(mac.finalize().into_bytes()),
            "10e436e61b69852ab70a2d81601f79a3284fb3f4d0d3495ff57b60b4c32e4a52"
        );
    }
}
