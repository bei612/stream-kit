//! Connection-owned remote output lifecycle. The network adapter supplies an
//! independently verified live authority projection while holding its state lock.
use crate::{
    AudioTarget, FRAME_SAMPLES,
    admission::{Admitted, Binding},
    wire::{self, Generation},
};
use std::time::{Duration, Instant};

/// Construct only from current signed control state after checking controller,
/// microphone policy, media membership, node routing and connection leases.
/// Absence means revoked/unavailable. Ticket claims cannot renew this authority.
pub struct LiveAuthority {
    pub binding: Binding,
    pub expires: Instant,
}

pub trait Output {
    fn submit_captured(&self, samples: &[f32], captured: Instant) -> bool;
    fn clear(&self);
}
impl Output for AudioTarget {
    fn submit_captured(&self, samples: &[f32], captured: Instant) -> bool {
        self.submit_captured(samples, captured)
    }
    fn clear(&self) {
        self.clear();
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReceiveError {
    #[error("remote microphone authority ended")]
    Revoked,
    #[error(transparent)]
    Frame(#[from] wire::FrameError),
}

/// Owns and releases the native output, so a closed connection cannot keep an
/// endpoint open. The adapter must recheck even when idle using `check` and must
/// hold the authority lock through submission to serialize revocation/writes.
pub struct RemoteOutput<O: Output> {
    binding: Binding,
    receiver: wire::Receiver,
    output: Option<O>,
    samples: [f32; FRAME_SAMPLES],
}
impl<O: Output> RemoteOutput<O> {
    pub fn new(admission: Admitted, output: O) -> Self {
        let binding = admission.binding;
        let receiver = wire::Receiver::new(Generation {
            target: binding.target_epoch,
            controller: binding.control_epoch,
        })
        .expect("verified admission generation");
        Self {
            binding,
            receiver,
            output: Some(output),
            samples: [0.; FRAME_SAMPLES],
        }
    }

    pub fn check(&mut self, authority: Option<&LiveAuthority>, now: Instant) -> bool {
        let valid = self.output.is_some()
            && authority.is_some_and(|state| state.binding == self.binding && now < state.expires);
        if !valid {
            self.close();
        }
        valid
    }

    /// Receipt clocks must be sampled together, before decoding/dispatch. `now`
    /// includes local dispatch delay. Output retains the original capture age.
    pub fn receive(
        &mut self,
        frame: &[u8],
        authority: Option<&LiveAuthority>,
        received_unix_ms: u64,
        received: Instant,
        now: Instant,
    ) -> Result<bool, ReceiveError> {
        if !self.check(authority, now) {
            return Err(ReceiveError::Revoked);
        }
        let decoded = self
            .receiver
            .decode(frame, received_unix_ms, &mut self.samples);
        let captured = decoded.and_then(|age| {
            received
                .checked_sub(Duration::from_millis(age))
                .filter(|captured| {
                    now.checked_duration_since(*captured)
                        .is_some_and(|elapsed| elapsed < Duration::from_millis(wire::MAX_AGE_MS))
                })
                .ok_or(wire::FrameError::Expired)
        });
        match captured {
            Ok(captured) => Ok(self
                .output
                .as_ref()
                .expect("checked active output")
                .submit_captured(&self.samples, captured)),
            Err(error) => {
                self.close();
                Err(error.into())
            }
        }
    }

    pub fn close(&mut self) {
        if let Some(output) = self.output.take() {
            output.clear();
        }
        self.samples.fill(0.);
    }
}
impl<O: Output> Drop for RemoteOutput<O> {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission::Admissions;
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Observed {
        writes: usize,
        clears: usize,
        drops: usize,
        captured: Option<Instant>,
    }
    struct Device(Arc<Mutex<Observed>>);
    impl Output for Device {
        fn submit_captured(&self, _: &[f32], captured: Instant) -> bool {
            let mut s = self.0.lock().unwrap();
            s.writes += 1;
            s.captured = Some(captured);
            true
        }
        fn clear(&self) {
            self.0.lock().unwrap().clears += 1;
        }
    }
    impl Drop for Device {
        fn drop(&mut self) {
            self.0.lock().unwrap().drops += 1;
        }
    }

    #[test]
    fn authenticated_frame_submission_and_revocation_release_owned_device() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/audio-devices/remote-microphone-v1.fixture.json"
        ))
        .unwrap();
        let key: Vec<u8> = f["node_key_hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect();
        let binding: Binding = serde_json::from_value(f["claims"].clone()).unwrap();
        for mode in [
            "missing",
            "expired",
            "transfer",
            "malformed",
            "disconnect",
            "task-drop",
            "delayed-dispatch",
        ] {
            let admitted = Admissions::new(1)
                .admit(
                    f["token"].as_str().unwrap(),
                    &key,
                    &binding,
                    f["now"].as_i64().unwrap(),
                )
                .unwrap();
            let observed = Arc::new(Mutex::new(Observed::default()));
            let mut output = RemoteOutput::new(admitted, Device(observed.clone()));
            let now = Instant::now();
            let mut authority = LiveAuthority {
                binding: binding.clone(),
                expires: now + Duration::from_secs(1),
            };
            let mut frame = [0; wire::FRAME_BYTES];
            wire::encode(
                Generation {
                    target: binding.target_epoch,
                    controller: binding.control_epoch,
                },
                1,
                1000,
                &[0.5; FRAME_SAMPLES],
                &mut frame,
            )
            .unwrap();
            assert_eq!(
                output.receive(&frame, Some(&authority), 1050, now, now),
                Ok(true)
            );
            assert_eq!(
                observed.lock().unwrap().captured,
                now.checked_sub(Duration::from_millis(50))
            );
            if mode == "task-drop" {
                // Simulate cancellation of a task that never calls close().
                drop(output);
                let result = observed.lock().unwrap();
                assert_eq!((result.writes, result.clears, result.drops), (1, 1, 1));
                continue;
            }
            match mode {
                "missing" => assert!(!output.check(None, now)),
                "expired" => assert!(!output.check(Some(&authority), authority.expires)),
                "transfer" => {
                    authority.binding.control_epoch += 1;
                    assert!(!output.check(Some(&authority), now));
                }
                "malformed" => assert!(
                    output
                        .receive(&[], Some(&authority), 1050, now, now)
                        .is_err()
                ),
                "delayed-dispatch" => {
                    wire::encode(
                        Generation {
                            target: binding.target_epoch,
                            controller: binding.control_epoch,
                        },
                        2,
                        1000,
                        &[0.5; FRAME_SAMPLES],
                        &mut frame,
                    )
                    .unwrap();
                    assert_eq!(
                        output.receive(
                            &frame,
                            Some(&authority),
                            1050,
                            now,
                            now + Duration::from_millis(10)
                        ),
                        Err(ReceiveError::Frame(wire::FrameError::Expired))
                    );
                }
                _ => output.close(),
            }
            assert!(
                output
                    .receive(&frame, Some(&authority), 1050, now, now)
                    .is_err()
            );
            drop(output);
            let result = observed.lock().unwrap();
            assert_eq!((result.writes, result.clears, result.drops), (1, 1, 1));
        }
    }
}
