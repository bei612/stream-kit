//! Versioned microphone PCM frames for authenticated rendering-node transport.
//! This codec does not authenticate a peer or authorize device access. Callers
//! must independently validate a live session snapshot before every submission.
use crate::FRAME_SAMPLES;

const HEADER_BYTES: usize = 36;
pub const FRAME_BYTES: usize = HEADER_BYTES + FRAME_SAMPLES * 4;
/// Same lifetime as the native output queue. Transport must not replay backlog.
pub const MAX_AGE_MS: u64 = crate::pcm::MAX_AGE.as_millis() as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Generation {
    pub target: u64,
    pub controller: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("invalid microphone frame format")]
    Format,
    #[error("microphone frame generation mismatch")]
    Generation,
    #[error("microphone frame is not fresh")]
    Expired,
    #[error("microphone frame sequence is not increasing")]
    Sequence,
    #[error("microphone frame has non-finite samples")]
    Samples,
}

/// Encode one 20ms, 48kHz, interleaved stereo f32 frame without allocation.
/// Timestamp is Unix milliseconds at original capture/ingress, never send time.
pub fn encode(
    generation: Generation,
    sequence: u64,
    captured_ms: u64,
    samples: &[f32],
    output: &mut [u8; FRAME_BYTES],
) -> Result<(), FrameError> {
    if generation.target == 0 || generation.controller == 0 || sequence == 0 {
        return Err(FrameError::Format);
    }
    if samples.len() != FRAME_SAMPLES {
        return Err(FrameError::Format);
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(FrameError::Samples);
    }
    output[..4].copy_from_slice(b"SKM1");
    for (offset, value) in [
        (4, generation.target),
        (12, generation.controller),
        (20, sequence),
        (28, captured_ms),
    ] {
        output[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    for (slot, sample) in output[HEADER_BYTES..]
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(samples)
    {
        slot.copy_from_slice(&sample.to_le_bytes());
    }
    Ok(())
}

/// Connection-scoped replay guard. Construct only after authenticated admission;
/// discard on revoke/reconnect and clear the associated native output queue.
pub struct Receiver {
    generation: Generation,
    sequence: u64,
}

impl Receiver {
    pub fn new(generation: Generation) -> Result<Self, FrameError> {
        if generation.target == 0 || generation.controller == 0 {
            return Err(FrameError::Generation);
        }
        Ok(Self {
            generation,
            sequence: 0,
        })
    }

    /// Check against the receiver's current synchronized Unix time. Future
    /// timestamps are rejected; clock skew must be resolved before admission.
    /// Returns source age so the output queue can retain the original deadline.
    /// Failure leaves both sequence state and output buffer unchanged.
    pub fn decode(
        &mut self,
        input: &[u8],
        now_ms: u64,
        output: &mut [f32; FRAME_SAMPLES],
    ) -> Result<u64, FrameError> {
        if input.len() != FRAME_BYTES || &input[..4] != b"SKM1" {
            return Err(FrameError::Format);
        }
        let read = |offset| {
            u64::from_le_bytes(
                input[offset..offset + 8]
                    .try_into()
                    .expect("bounded header"),
            )
        };
        if read(4) != self.generation.target || read(12) != self.generation.controller {
            return Err(FrameError::Generation);
        }
        let sequence = read(20);
        if sequence <= self.sequence {
            return Err(FrameError::Sequence);
        }
        let age = now_ms
            .checked_sub(read(28))
            .filter(|age| *age < MAX_AGE_MS)
            .ok_or(FrameError::Expired)?;
        let samples = || {
            input[HEADER_BYTES..]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|bytes| f32::from_le_bytes(*bytes))
        };
        if samples().any(|sample| !sample.is_finite()) {
            return Err(FrameError::Samples);
        }
        for (slot, sample) in output.iter_mut().zip(samples()) {
            *slot = sample;
        }
        self.sequence = sequence;
        Ok(age)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_rejects_invalid_inputs_without_partial_output() {
        let generation = Generation {
            target: 2,
            controller: 3,
        };
        let mut output = [0x55; FRAME_BYTES];
        for (authority, sequence, samples) in [
            (
                Generation {
                    target: 0,
                    controller: 3,
                },
                1,
                vec![0.; FRAME_SAMPLES],
            ),
            (
                Generation {
                    target: 2,
                    controller: 0,
                },
                1,
                vec![0.; FRAME_SAMPLES],
            ),
            (generation, 0, vec![0.; FRAME_SAMPLES]),
            (generation, 1, vec![0.; FRAME_SAMPLES - 1]),
            (generation, 1, vec![f32::NAN; FRAME_SAMPLES]),
        ] {
            assert!(encode(authority, sequence, 1000, &samples, &mut output).is_err());
            assert_eq!(output, [0x55; FRAME_BYTES]);
        }
        assert!(
            Receiver::new(Generation {
                target: 0,
                controller: 1
            })
            .is_err()
        );
    }

    #[test]
    fn frame_layout_and_replay_guard() {
        let generation = Generation {
            target: 2,
            controller: 3,
        };
        let samples = [0.25; FRAME_SAMPLES];
        let mut bytes = [0; FRAME_BYTES];
        encode(generation, 1, 1000, &samples, &mut bytes).unwrap();
        assert_eq!(&bytes[..12], &[83, 75, 77, 49, 2, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&bytes[36..40], &0.25f32.to_le_bytes());
        let mut receiver = Receiver::new(generation).unwrap();
        let mut decoded = [0.; FRAME_SAMPLES];
        assert_eq!(receiver.decode(&bytes, 1059, &mut decoded), Ok(59));
        assert_eq!(decoded, samples);
        assert_eq!(
            receiver.decode(&bytes, 1059, &mut decoded),
            Err(FrameError::Sequence)
        );
        encode(generation, 3, 1000, &samples, &mut bytes).unwrap();
        assert_eq!(receiver.decode(&bytes, 1059, &mut decoded), Ok(59));
        encode(generation, 2, 1000, &samples, &mut bytes).unwrap();
        assert_eq!(
            receiver.decode(&bytes, 1059, &mut decoded),
            Err(FrameError::Sequence)
        );
    }

    #[test]
    fn reject_invalid_without_mutating_output_or_replay_state() {
        let generation = Generation {
            target: 2,
            controller: 3,
        };
        let mut valid = [0; FRAME_BYTES];
        encode(generation, 1, 1000, &[0.25; FRAME_SAMPLES], &mut valid).unwrap();
        for mode in 0..8 {
            let mut receiver = Receiver::new(generation).unwrap();
            let mut bytes = valid;
            let mut output = [0.5; FRAME_SAMPLES];
            let mut now = 1000;
            match mode {
                0 => bytes[0] = 0,
                1 => bytes[4] = 9,
                2 => bytes[12] = 9,
                3 => bytes[20] = 0,
                4 => now = 999,
                5 => now = 1060,
                6 => bytes[36..40].copy_from_slice(&f32::NAN.to_le_bytes()),
                _ => bytes[36..40].copy_from_slice(&f32::INFINITY.to_le_bytes()),
            }
            assert!(receiver.decode(&bytes, now, &mut output).is_err());
            assert_eq!(output, [0.5; FRAME_SAMPLES]);
            assert_eq!(receiver.decode(&valid, 1000, &mut output), Ok(0));
        }
        let mut receiver = Receiver::new(generation).unwrap();
        for size in [0, 3, 35, FRAME_BYTES - 1, FRAME_BYTES + 1] {
            assert_eq!(
                receiver.decode(&vec![0; size], 1000, &mut [0.; FRAME_SAMPLES]),
                Err(FrameError::Format)
            );
        }
    }
}
