use std::time::{Duration, Instant};

pub const FRAME_SAMPLES: usize = 960 * 2;
const MAX_FRAMES: usize = 3;
pub(crate) const MAX_AGE: Duration = Duration::from_millis(60);

struct Frame {
    queued: Instant,
    samples: [f32; FRAME_SAMPLES],
    offset: usize,
}

/// Callback-owned consumption of a bounded stereo PCM queue. Each input is
/// timestamped so a stopped device cannot replay old microphone after recovery.
pub(crate) struct PcmQueue {
    frames: [Frame; MAX_FRAMES],
    head: usize,
    len: usize,
}
impl Default for PcmQueue {
    fn default() -> Self {
        Self {
            frames: std::array::from_fn(|_| Frame {
                queued: Instant::now(),
                samples: [0.0; FRAME_SAMPLES],
                offset: 0,
            }),
            head: 0,
            len: 0,
        }
    }
}
impl PcmQueue {
    pub fn push(&mut self, samples: &[f32], now: Instant) -> Option<bool> {
        if samples.len() != FRAME_SAMPLES || samples.iter().any(|sample| !sample.is_finite()) {
            return None;
        }
        let dropped = self.len == MAX_FRAMES;
        if dropped {
            self.pop();
        }
        let frame = &mut self.frames[(self.head + self.len) % MAX_FRAMES];
        frame.samples.copy_from_slice(samples);
        frame.queued = now;
        frame.offset = 0;
        self.len += 1;
        Some(dropped)
    }
    fn pop(&mut self) {
        self.head = (self.head + 1) % MAX_FRAMES;
        self.len -= 1;
    }
    pub fn clear(&mut self) {
        self.len = 0;
    }
    pub fn stereo(&mut self, now: Instant) -> [f32; 2] {
        while self.len > 0 {
            let frame = &self.frames[self.head];
            if now.saturating_duration_since(frame.queued) < MAX_AGE && frame.offset < FRAME_SAMPLES
            {
                break;
            }
            self.pop();
        }
        if self.len == 0 {
            return [0.0; 2];
        }
        let frame = &mut self.frames[self.head];
        let pair = [
            frame.samples[frame.offset].clamp(-1.0, 1.0),
            frame.samples[frame.offset + 1].clamp(-1.0, 1.0),
        ];
        frame.offset += 2;
        pair
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_queue_prefers_recent_audio_and_expires_it() {
        let mut queue = PcmQueue::default();
        let now = Instant::now();
        for i in 0..10 {
            assert!(queue.push(&[i as f32 / 10.0; FRAME_SAMPLES], now).is_some());
        }
        assert_eq!(queue.len, 3);
        assert_eq!(queue.stereo(now), [0.7, 0.7]);
        assert_eq!(queue.stereo(now + MAX_AGE), [0.0, 0.0]);
    }
    #[test]
    fn revoke_clears_partial_callback_frame() {
        let mut queue = PcmQueue::default();
        let now = Instant::now();
        queue.push(&[0.5; FRAME_SAMPLES], now);
        assert_eq!(queue.stereo(now), [0.5, 0.5]);
        queue.clear();
        assert_eq!(queue.stereo(now), [0.0, 0.0]);
    }
    #[test]
    fn malformed_or_nonfinite_pcm_never_reaches_device() {
        let mut queue = PcmQueue::default();
        let now = Instant::now();
        assert!(queue.push(&[1.0], now).is_none());
        assert!(queue.push(&[f32::NAN; FRAME_SAMPLES], now).is_none());
        assert_eq!(queue.stereo(now), [0.0, 0.0]);
    }
}
