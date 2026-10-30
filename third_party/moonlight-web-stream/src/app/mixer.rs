use opus::{Application, Channels, Decoder, Encoder};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

/// One stereo 48 kHz mix per rendering session. Host packets supply the output
/// clock; a bounded microphone FIFO absorbs differing Opus packet durations.
pub struct AudioMixer {
    host: Decoder,
    microphone: Decoder,
    encoder: Encoder,
    pending: VecDeque<f32>,
    last_microphone: Option<Instant>,
    scratch: Vec<f32>,
    program_gain: f32,
    microphone_gain: f32,
}

impl AudioMixer {
    pub fn new() -> Result<Self, opus::Error> {
        Ok(Self {
            host: Decoder::new(48_000, Channels::Stereo)?,
            microphone: Decoder::new(48_000, Channels::Stereo)?,
            encoder: Encoder::new(48_000, Channels::Stereo, Application::Audio)?,
            pending: VecDeque::new(),
            last_microphone: None,
            scratch: vec![0.0; 5760 * 2],
            program_gain: 1.0,
            microphone_gain: 1.0,
        })
    }

    pub fn configure(&mut self, policy: &super::control_state::AudioPolicy) {
        self.program_gain = 10.0f32.powf(policy.program_gain_db / 20.0);
        self.microphone_gain =
            if policy.microphone_enabled && policy.broadcast_controller_microphone {
                10.0f32.powf(policy.microphone_gain_db / 20.0)
            } else {
                0.0
            };
        if self.microphone_gain == 0.0 {
            self.pending.clear();
        }
    }

    pub fn clear_microphone(&mut self) -> Result<(), opus::Error> {
        self.pending.clear();
        self.last_microphone = None;
        self.microphone.reset_state()
    }

    pub fn microphone(&mut self, packet: &[u8]) -> Result<(), opus::Error> {
        let count = self
            .microphone
            .decode_float(packet, &mut self.scratch, false)?
            * 2;
        self.pending.extend(&self.scratch[..count]);
        // Never retain more than 200 ms, even if a sender floods valid packets.
        let excess = self.pending.len().saturating_sub(48_000 * 2 / 5);
        self.pending.drain(..excess);
        self.last_microphone = Some(Instant::now());
        Ok(())
    }

    pub fn mix(&mut self, host_packet: &[u8]) -> Result<Vec<u8>, opus::Error> {
        if self
            .last_microphone
            .is_some_and(|time| time.elapsed() > Duration::from_millis(200))
        {
            self.clear_microphone()?;
        }
        let count = self
            .host
            .decode_float(host_packet, &mut self.scratch, false)?
            * 2;
        for sample in &mut self.scratch[..count] {
            *sample = (*sample * self.program_gain
                + self.pending.pop_front().unwrap_or(0.0) * self.microphone_gain)
                .clamp(-1.0, 1.0);
        }
        let mut output = vec![0; 4000];
        let len = self
            .encoder
            .encode_float(&self.scratch[..count], &mut output)?;
        output.truncate(len);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(samples: &[f32]) -> Vec<u8> {
        let mut encoder = Encoder::new(48_000, Channels::Stereo, Application::Audio).unwrap();
        let mut output = vec![0; 4000];
        let len = encoder.encode_float(samples, &mut output).unwrap();
        output.truncate(len);
        output
    }
    #[test]
    fn microphone_is_audible_in_mix_and_fifo_is_bounded() {
        let mut mixer = AudioMixer::new().unwrap();
        let tone: Vec<f32> = (0..1920)
            .map(|i| ((i / 2) as f32 * 0.06).sin() * 0.3)
            .collect();
        let voice = packet(&tone);
        for _ in 0..100 {
            mixer.microphone(&voice).unwrap();
        }
        assert!(mixer.pending.len() <= 19200);
        let mixed = mixer.mix(&packet(&vec![0.0; 1920])).unwrap();
        let mut decoder = Decoder::new(48_000, Channels::Stereo).unwrap();
        let mut pcm = vec![0.0; 11520];
        let count = decoder.decode_float(&mixed, &mut pcm, false).unwrap() * 2;
        assert!(pcm[..count].iter().any(|sample| sample.abs() > 0.01));
        mixer.clear_microphone().unwrap();
        assert!(mixer.pending.is_empty());
    }

    #[test]
    fn stale_microphone_is_removed_before_next_host_frame() {
        let mut mixer = AudioMixer::new().unwrap();
        mixer.microphone(&packet(&vec![0.5; 1920])).unwrap();
        mixer.last_microphone = Some(Instant::now() - Duration::from_secs(1));
        mixer.mix(&packet(&vec![0.0; 1920])).unwrap();
        assert!(mixer.pending.is_empty());
        assert!(mixer.last_microphone.is_none());
    }
}
