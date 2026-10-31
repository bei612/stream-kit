use opus::{Application, Channels, Decoder, Encoder};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

pub const FRAME_DURATION: Duration = Duration::from_millis(20);
const FRAME_SAMPLES: usize = 960 * 2;
const MAX_PENDING: usize = FRAME_SAMPLES * 10;
const MAX_AGE: Duration = Duration::from_millis(200);

/// Scheduling and RTP time share one monotonic session epoch. Missed deadlines
/// advance media time; they never produce a burst of old frames.
pub struct AudioClock {
    epoch: tokio::time::Instant,
    interval: tokio::time::Interval,
}
impl AudioClock {
    pub fn new() -> Self {
        let epoch = tokio::time::Instant::now();
        let mut interval = tokio::time::interval_at(epoch + FRAME_DURATION, FRAME_DURATION);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        Self { epoch, interval }
    }
    pub async fn tick(&mut self) -> Duration {
        self.interval.tick().await;
        let elapsed = self.epoch.elapsed().as_millis();
        let slot = (elapsed / FRAME_DURATION.as_millis()).saturating_sub(1);
        Duration::from_millis((slot * FRAME_DURATION.as_millis()) as u64)
    }
}

/// A decoded input owns its codec history and bounded interleaved stereo FIFO.
struct AudioInput {
    decoder: Decoder,
    pending: VecDeque<f32>,
    arrivals: VecDeque<(usize, Instant)>,
    max_age: Duration,
    last_packet: Option<Instant>,
}
impl AudioInput {
    fn new(max_age: Duration) -> Result<Self, opus::Error> {
        Ok(Self {
            decoder: Decoder::new(48_000, Channels::Stereo)?,
            pending: VecDeque::with_capacity(MAX_PENDING),
            arrivals: VecDeque::new(),
            max_age,
            last_packet: None,
        })
    }
    fn push(
        &mut self,
        packet: &[u8],
        scratch: &mut [f32],
        now: Instant,
    ) -> Result<(), opus::Error> {
        if self.last_packet.is_some_and(|previous| now < previous) {
            return Ok(());
        }
        self.expire(now)?;
        let count = self.decoder.decode_float(packet, scratch, false)? * 2;
        self.pending.extend(&scratch[..count]);
        if count > 0 {
            self.arrivals.push_back((count, now));
        }
        self.discard(self.pending.len().saturating_sub(MAX_PENDING));
        self.last_packet = Some(now);
        Ok(())
    }
    fn discard(&mut self, count: usize) {
        let count = count.min(self.pending.len());
        self.pending.drain(..count);
        let mut remaining = count;
        while remaining > 0 {
            let (samples, _) = self
                .arrivals
                .front_mut()
                .expect("queued samples have arrival metadata");
            let consumed = remaining.min(*samples);
            *samples -= consumed;
            remaining -= consumed;
            if *samples == 0 {
                self.arrivals.pop_front();
            }
        }
    }
    fn pop(&mut self) -> Option<(f32, Instant)> {
        let value = self.pending.pop_front()?;
        let (samples, arrived) = self
            .arrivals
            .front_mut()
            .expect("queued samples have arrival metadata");
        let arrived = *arrived;
        *samples -= 1;
        if *samples == 0 {
            self.arrivals.pop_front();
        }
        Some((value, arrived))
    }
    fn clear(&mut self) -> Result<(), opus::Error> {
        self.pending.clear();
        self.arrivals.clear();
        self.last_packet = None;
        self.decoder.reset_state()
    }
    fn expire(&mut self, now: Instant) -> Result<(), opus::Error> {
        if self
            .last_packet
            .is_some_and(|time| now.saturating_duration_since(time) >= self.max_age)
        {
            self.clear()?;
        }
        // A new packet must not renew the lifetime of older decoded samples.
        while let Some(&(samples, arrived)) = self.arrivals.front() {
            if now.saturating_duration_since(arrived) < self.max_age {
                break;
            }
            self.discard(samples);
        }
        Ok(())
    }
}

/// One 48 kHz stereo bus per session. Arrival only fills inputs; the session
/// clock renders 20 ms frames even when the program sends no audio.
pub struct AudioMixer {
    program: AudioInput,
    microphone: AudioInput,
    encoder: Encoder,
    scratch: Vec<f32>,
    output: Vec<f32>,
    target_output: Vec<f32>,
    target_captured: Option<Instant>,
    program_gain: f32,
    microphone_gain: f32,
    broadcast_microphone: bool,
    target_epoch: u64,
    last_output: Option<Duration>,
}
impl AudioMixer {
    pub fn new() -> Result<Self, opus::Error> {
        Ok(Self {
            program: AudioInput::new(MAX_AGE)?,
            microphone: AudioInput::new(Duration::from_millis(
                stream_kit_audio_target::wire::MAX_AGE_MS,
            ))?,
            encoder: Encoder::new(48_000, Channels::Stereo, Application::Audio)?,
            scratch: vec![0.0; 5760 * 2],
            output: vec![0.0; FRAME_SAMPLES],
            target_output: vec![0.0; FRAME_SAMPLES],
            target_captured: None,
            program_gain: 1.0,
            microphone_gain: 1.0,
            broadcast_microphone: true,
            target_epoch: 0,
            last_output: None,
        })
    }
    pub fn configure(
        &mut self,
        policy: &super::control_state::AudioPolicy,
    ) -> Result<(), opus::Error> {
        if self.target_epoch != policy.target.epoch {
            self.clear_microphone()?;
            self.target_epoch = policy.target.epoch;
        }
        self.program_gain = 10.0f32.powf(policy.program_gain_db / 20.0);
        let microphone_gain = if policy.microphone_enabled {
            10.0f32.powf(policy.microphone_gain_db / 20.0)
        } else {
            0.0
        };
        if microphone_gain == 0.0 && self.microphone_gain != 0.0 {
            self.clear_microphone()?;
        }
        if self.broadcast_microphone && !policy.broadcast_controller_microphone {
            self.encoder.reset_state()?;
        }
        self.broadcast_microphone = policy.broadcast_controller_microphone;
        self.microphone_gain = microphone_gain;
        Ok(())
    }
    pub fn clear_microphone(&mut self) -> Result<(), opus::Error> {
        self.microphone.clear()?;
        self.target_output.fill(0.0);
        self.target_captured = None;
        // Remove microphone history in the output codec as well.
        self.encoder.reset_state()
    }
    pub fn microphone(&mut self, packet: &[u8], now: Instant) -> Result<(), opus::Error> {
        if self.microphone_gain == 0.0 {
            return Ok(());
        }
        self.microphone.push(packet, &mut self.scratch, now)
    }
    pub fn program(&mut self, packet: &[u8], now: Instant) -> Result<(), opus::Error> {
        self.program.push(packet, &mut self.scratch, now)
    }
    pub fn target_pcm(&self) -> &[f32] {
        &self.target_output
    }
    pub fn target_frame(&self) -> Option<(&[f32], Instant)> {
        self.target_captured
            .map(|captured| (self.target_pcm(), captured))
    }
    pub fn render(&mut self, timestamp: Duration, now: Instant) -> Result<Vec<u8>, opus::Error> {
        self.program.expire(now)?;
        self.microphone.expire(now)?;
        if let Some(previous) = self.last_output {
            // Drop skipped clock slots instead of replaying a delayed backlog.
            let missed = timestamp
                .saturating_sub(previous)
                .as_millis()
                .saturating_sub(FRAME_DURATION.as_millis())
                / FRAME_DURATION.as_millis();
            let discard = (missed.min(10) as usize) * FRAME_SAMPLES;
            self.program.discard(discard);
            self.microphone.discard(discard);
        }
        self.last_output = Some(timestamp);
        let mut captured = now;
        for (sample, target) in self.output.iter_mut().zip(&mut self.target_output) {
            let microphone = self
                .microphone
                .pop()
                .map(|(value, arrived)| {
                    captured = captured.min(arrived);
                    value
                })
                .unwrap_or(0.0);
            *target = (microphone * self.microphone_gain).clamp(-1.0, 1.0);
            *sample = (self.program.pop().map(|(value, _)| value).unwrap_or(0.0)
                * self.program_gain
                + if self.broadcast_microphone {
                    *target
                } else {
                    0.0
                })
            .clamp(-1.0, 1.0);
        }
        self.target_captured = Some(captured);
        let mut packet = vec![0; 4000];
        let len = self.encoder.encode_float(&self.output, &mut packet)?;
        packet.truncate(len);
        Ok(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn clock_runs_without_input_and_skips_missed_deadlines() {
        let mut clock = AudioClock::new();
        assert_eq!(clock.tick().await, Duration::ZERO);
        assert_eq!(clock.tick().await, FRAME_DURATION);
        tokio::time::advance(Duration::from_millis(100)).await;
        assert_eq!(clock.tick().await, Duration::from_millis(120));
        assert_eq!(clock.tick().await, Duration::from_millis(140));
    }
    fn tone(count: usize) -> Vec<u8> {
        let samples: Vec<f32> = (0..count)
            .map(|i| ((i / 2) as f32 * 0.06).sin() * 0.3)
            .collect();
        let mut encoder = Encoder::new(48_000, Channels::Stereo, Application::Audio)
            .expect("Opus mixer test operation must succeed");
        let mut output = vec![0; 4000];
        let len = encoder
            .encode_float(&samples, &mut output)
            .expect("Opus mixer test operation must succeed");
        output.truncate(len);
        output
    }
    fn decoded(packet: &[u8]) -> Vec<f32> {
        let mut decoder =
            Decoder::new(48_000, Channels::Stereo).expect("Opus mixer test operation must succeed");
        let mut pcm = vec![0.0; 11520];
        let count = decoder
            .decode_float(packet, &mut pcm, false)
            .expect("Opus mixer test operation must succeed")
            * 2;
        pcm.truncate(count);
        pcm
    }
    #[test]
    fn microphone_renders_without_any_program_packet() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        mixer
            .microphone(&tone(FRAME_SAMPLES), now)
            .expect("Opus mixer test operation must succeed");
        let pcm = decoded(
            &mixer
                .render(Duration::ZERO, now)
                .expect("Opus mixer test operation must succeed"),
        );
        assert_eq!(pcm.len(), FRAME_SAMPLES);
        assert!(pcm.iter().any(|sample| sample.abs() > 0.01));
    }
    #[test]
    fn fresh_packet_does_not_renew_old_microphone_audio() {
        let arrived = Instant::now();
        let mut mixer = AudioMixer::new().expect("create mixer");
        mixer
            .microphone(&tone(FRAME_SAMPLES), arrived)
            .expect("old microphone packet");
        mixer
            .program(&tone(FRAME_SAMPLES), arrived)
            .expect("program packet");
        let fresh = arrived + Duration::from_millis(55);
        mixer
            .microphone(&tone(FRAME_SAMPLES), fresh)
            .expect("fresh microphone packet");
        mixer
            .render(Duration::ZERO, arrived + Duration::from_millis(60))
            .expect("render frame");
        let (samples, captured) = mixer.target_frame().expect("rendered microphone frame");
        assert_eq!(
            captured, fresh,
            "expired speech must not precede the fresh packet"
        );
        assert!(samples.iter().any(|sample| sample.abs() > 0.01));
        assert!(mixer.microphone.pending.is_empty());
        assert!(mixer.microphone.arrivals.is_empty());
        assert!(
            mixer.program.pending.is_empty(),
            "program uses its own longer jitter budget"
        );
    }

    #[test]
    fn mixed_packet_frame_retains_oldest_arrival_and_rejects_reordered_ingress() {
        let arrived = Instant::now();
        let mut mixer = AudioMixer::new().expect("create mixer");
        for offset in [0, 10, 20, 30] {
            mixer
                .microphone(
                    &tone(FRAME_SAMPLES / 4),
                    arrived + Duration::from_millis(offset),
                )
                .expect("partial packet");
        }
        mixer
            .microphone(&tone(FRAME_SAMPLES), arrived + Duration::from_millis(5))
            .expect("late packet is ignored");
        assert_eq!(mixer.microphone.pending.len(), FRAME_SAMPLES);
        mixer
            .render(Duration::ZERO, arrived + Duration::from_millis(50))
            .expect("render frame");
        assert_eq!(
            mixer.target_frame().expect("target frame").1,
            arrived,
            "mixing must not give speech a new 60ms lifetime"
        );
        assert!(mixer.microphone.arrivals.is_empty());
        mixer.clear_microphone().expect("clear microphone");
        assert!(mixer.target_frame().is_none());
    }

    #[test]
    fn both_inputs_are_bounded_and_stale_audio_is_not_replayed() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        let voice = tone(FRAME_SAMPLES);
        for _ in 0..100 {
            mixer
                .microphone(&voice, now)
                .expect("Opus mixer test operation must succeed");
            mixer
                .program(&voice, now)
                .expect("Opus mixer test operation must succeed");
        }
        assert_eq!(mixer.microphone.pending.len(), MAX_PENDING);
        assert_eq!(mixer.program.pending.len(), MAX_PENDING);
        let pcm = decoded(
            &mixer
                .render(Duration::from_secs(1), now + Duration::from_secs(1))
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(pcm.iter().all(|sample| sample.abs() < 0.0001));
        assert!(mixer.microphone.pending.is_empty());
        assert!(mixer.program.pending.is_empty());
    }
    #[test]
    fn different_packet_durations_feed_a_fixed_output_clock() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        for _ in 0..4 {
            mixer
                .program(&tone(480), now)
                .expect("Opus mixer test operation must succeed");
        }
        mixer
            .microphone(&tone(3840), now)
            .expect("Opus mixer test operation must succeed");
        for i in 0..2 {
            let pcm = decoded(
                &mixer
                    .render(FRAME_DURATION * i, now + FRAME_DURATION * i)
                    .expect("Opus mixer test operation must succeed"),
            );
            assert_eq!(pcm.len(), FRAME_SAMPLES);
            assert!(pcm.iter().any(|sample| sample.abs() > 0.01));
        }
        assert!(mixer.program.pending.is_empty());
        assert!(mixer.microphone.pending.is_empty());
    }
    #[test]
    fn clock_skips_discard_backlog_without_a_catch_up_burst() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        for _ in 0..10 {
            mixer
                .program(&tone(FRAME_SAMPLES), now)
                .expect("Opus mixer test operation must succeed");
        }
        mixer
            .render(Duration::ZERO, now)
            .expect("Opus mixer test operation must succeed");
        mixer
            .render(FRAME_DURATION * 4, now + FRAME_DURATION * 4)
            .expect("Opus mixer test operation must succeed");
        assert_eq!(mixer.program.pending.len(), FRAME_SAMPLES * 5);
    }
    #[test]
    fn revocation_clears_fifo_and_encoder_history() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        mixer
            .microphone(&tone(3840), now)
            .expect("Opus mixer test operation must succeed");
        mixer
            .render(Duration::ZERO, now)
            .expect("Opus mixer test operation must succeed");
        mixer
            .clear_microphone()
            .expect("Opus mixer test operation must succeed");
        let pcm = decoded(
            &mixer
                .render(FRAME_DURATION, now + FRAME_DURATION)
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(pcm.iter().all(|sample| sample.abs() < 0.0001));
    }
    #[test]
    fn disabled_broadcast_does_not_retain_microphone_for_later() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        mixer
            .configure(&super::super::control_state::AudioPolicy {
                broadcast_controller_microphone: false,
                ..Default::default()
            })
            .expect("Opus mixer test operation must succeed");
        mixer
            .microphone(&tone(FRAME_SAMPLES), now)
            .expect("Opus mixer test operation must succeed");
        let private = decoded(
            &mixer
                .render(Duration::ZERO, now)
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(private.iter().all(|sample| sample.abs() < 0.0001));
        assert!(mixer.target_pcm().iter().any(|sample| sample.abs() > 0.01));
        mixer
            .configure(&Default::default())
            .expect("Opus mixer test operation must succeed");
        assert!(mixer.microphone.pending.is_empty());
        let pcm = decoded(
            &mixer
                .render(FRAME_DURATION, now + FRAME_DURATION)
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(pcm.iter().all(|sample| sample.abs() < 0.0001));
    }
    #[test]
    fn target_switch_discards_queued_speech_and_keeps_program_audio() {
        let now = Instant::now();
        let mut mixer =
            AudioMixer::new().expect("target switch regression setup or operation must succeed");
        let mut policy = super::super::control_state::AudioPolicy::default();
        policy.target.epoch = 1;
        mixer
            .configure(&policy)
            .expect("target switch regression setup or operation must succeed");
        mixer
            .program(&tone(FRAME_SAMPLES * 2), now)
            .expect("target switch regression setup or operation must succeed");
        mixer
            .microphone(&tone(FRAME_SAMPLES * 2), now)
            .expect("target switch regression setup or operation must succeed");
        mixer
            .render(Duration::ZERO, now)
            .expect("target switch regression setup or operation must succeed");
        assert!(mixer.target_pcm().iter().any(|value| value.abs() > 0.01));
        policy.target.epoch = 2;
        mixer
            .configure(&policy)
            .expect("target switch regression setup or operation must succeed");
        let program = decoded(
            &mixer
                .render(FRAME_DURATION, now + FRAME_DURATION)
                .expect("target switch regression setup or operation must succeed"),
        );
        assert!(program.iter().any(|value| value.abs() > 0.01));
        assert!(mixer.target_pcm().iter().all(|value| *value == 0.0));
        mixer
            .microphone(&tone(FRAME_SAMPLES), now + FRAME_DURATION * 2)
            .expect("target switch regression setup or operation must succeed");
        mixer
            .configure(&policy)
            .expect("target switch regression setup or operation must succeed");
        mixer
            .render(FRAME_DURATION * 2, now + FRAME_DURATION * 2)
            .expect("target switch regression setup or operation must succeed");
        assert!(
            mixer.target_pcm().iter().any(|value| value.abs() > 0.01),
            "fresh speech remains usable after a target switch"
        );
    }

    #[test]
    fn program_audio_never_loops_back_into_target_microphone() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        mixer
            .program(&tone(FRAME_SAMPLES), now)
            .expect("Opus mixer test operation must succeed");
        let pcm = decoded(
            &mixer
                .render(Duration::ZERO, now)
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(pcm.iter().any(|sample| sample.abs() > 0.01));
        assert!(mixer.target_pcm().iter().all(|sample| *sample == 0.0));
    }
    #[test]
    fn disabling_microphone_revokes_both_outputs() {
        let now = Instant::now();
        let mut mixer = AudioMixer::new().expect("Opus mixer test operation must succeed");
        mixer
            .microphone(&tone(FRAME_SAMPLES * 2), now)
            .expect("Opus mixer test operation must succeed");
        mixer
            .render(Duration::ZERO, now)
            .expect("Opus mixer test operation must succeed");
        mixer
            .configure(&super::super::control_state::AudioPolicy {
                microphone_enabled: false,
                ..Default::default()
            })
            .expect("Opus mixer test operation must succeed");
        let pcm = decoded(
            &mixer
                .render(FRAME_DURATION, now + FRAME_DURATION)
                .expect("Opus mixer test operation must succeed"),
        );
        assert!(pcm.iter().all(|sample| sample.abs() < 0.0001));
        assert!(mixer.target_pcm().iter().all(|sample| *sample == 0.0));
    }
}
