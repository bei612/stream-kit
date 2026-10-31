//! Explicit endpoint acceptance: emits a quiet 997 Hz test tone into the named
//! render device and verifies it on the named capture device. Never selects defaults.
use crate::{AudioTarget, EndpointPair, FRAME_SAMPLES};
use cpal::{
    DeviceId, SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Default)]
struct Measurement {
    frames: u64,
    sine: f64,
    cosine: f64,
    energy: f64,
    peak: f64,
}

impl Measurement {
    fn sample(&mut self, sample: f64) {
        let phase = self.frames as f64 * std::f64::consts::TAU * 997.0 / 48_000.0;
        self.sine += sample * phase.sin();
        self.cosine += sample * phase.cos();
        self.energy += sample * sample;
        self.peak = self.peak.max(sample.abs());
        self.frames += 1;
    }

    fn amplitude(&self) -> f64 {
        2.0 * self.sine.hypot(self.cosine) / self.frames.max(1) as f64
    }

    fn rms(&self) -> f64 {
        (self.energy / self.frames.max(1) as f64).sqrt()
    }

    fn quiet(&self) -> bool {
        self.frames >= 12_000 && self.rms() < 0.001 && self.peak < 0.003
    }

    fn report(&self) -> serde_json::Value {
        serde_json::json!({"captured_frames": self.frames, "tone_amplitude": self.amplitude(),
            "rms": self.rms(), "peak": self.peak, "quiet": self.quiet()})
    }
}

fn capture<T: cpal::SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    result: Arc<Mutex<Measurement>>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::Error>
where
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    device.build_input_stream(
        config,
        move |samples: &[T], _| {
            if let Ok(mut result) = result.try_lock() {
                for frame in samples.chunks_exact(channels) {
                    let sample = <f32 as cpal::FromSample<T>>::from_sample_(frame[0]) as f64;
                    result.sample(sample);
                }
            }
        },
        move |error| {
            failed.store(true, Ordering::Release);
            eprintln!("capture error: {error}");
        },
        None,
    )
}

/// Actively checks explicit endpoints. The caller must secure exclusive ownership.
pub fn verify_pair(pair: &EndpointPair) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let capture_id: DeviceId = pair.capture_device_id.parse()?;
    let host = cpal::host_from_id(capture_id.host())?;
    let device = host
        .device_by_id(&capture_id)
        .ok_or("capture device not found")?;
    let config = device
        .supported_input_configs()?
        .find(|config| {
            (1..=2).contains(&config.channels())
                && config.min_sample_rate() <= 48_000
                && config.max_sample_rate() >= 48_000
                && matches!(
                    config.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
                )
        })
        .ok_or("capture format unsupported")?
        .with_sample_rate(48_000);
    let result = Arc::new(Mutex::new(Measurement::default()));
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match config.sample_format() {
        SampleFormat::F32 => {
            capture::<f32>(&device, config.into(), result.clone(), failed.clone())?
        }
        SampleFormat::I16 => {
            capture::<i16>(&device, config.into(), result.clone(), failed.clone())?
        }
        SampleFormat::I32 => {
            capture::<i32>(&device, config.into(), result.clone(), failed.clone())?
        }
        _ => return Err("capture format unsupported".into()),
    };
    let target = AudioTarget::open(pair)?;
    stream.play()?;
    // The explicit endpoint must first be quiet. Otherwise an unrelated source
    // could satisfy the tone check without proving this route is connected.
    std::thread::sleep(Duration::from_millis(300));
    *result.lock().map_err(|_| "capture measurement poisoned")? = Measurement::default();
    std::thread::sleep(Duration::from_millis(500));
    let baseline = std::mem::take(&mut *result.lock().map_err(|_| "capture measurement poisoned")?);
    let start = Instant::now();
    let mut submitted = 0;
    for packet in 0..150 {
        let mut samples = [0.0; FRAME_SAMPLES];
        for (i, stereo) in samples.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let sample = ((packet * 960 + i) as f64 * std::f64::consts::TAU * 997.0 / 48_000.0)
                .sin() as f32
                * 0.1;
            stereo.fill(sample);
        }
        if target.submit(&samples) {
            submitted += 1;
        }
        std::thread::sleep(
            (start + Duration::from_millis((packet as u64 + 1) * 20))
                .saturating_duration_since(Instant::now()),
        );
    }
    target.clear();
    let tone = std::mem::take(&mut *result.lock().map_err(|_| "capture measurement poisoned")?);
    // Allow already-submitted OS audio buffers to drain before measuring. This
    // is a residual-audio check, not a claim of sample-accurate revocation.
    std::thread::sleep(Duration::from_millis(300));
    *result.lock().map_err(|_| "capture measurement poisoned")? = Measurement::default();
    std::thread::sleep(Duration::from_millis(500));
    stream.pause()?;
    let result = result.lock().map_err(|_| "capture measurement poisoned")?;
    let amplitude = tone.amplitude();
    let status = target.status();
    let monitor = target.monitor();
    drop(target);
    let closed_after_drop = !monitor.status().device_open;
    let passed = submitted >= 140
        && tone.frames > 48_000
        && amplitude > 0.01
        && baseline.quiet()
        && result.quiet()
        && status.device_open
        && closed_after_drop
        && !failed.load(Ordering::Acquire);
    Ok(
        serde_json::json!({"passed": passed, "captured_frames": tone.frames,
        "tone_amplitude": amplitude, "submitted_packets": submitted, "target": status,
        "baseline": baseline.report(), "after_clear": result.report(), "drain_before_silence_ms": 300,
        "closed_after_drop": closed_after_drop}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_requires_capture_and_rejects_tones_and_impulses() {
        let mut measurement = Measurement::default();
        assert!(!measurement.quiet(), "missing callbacks are not silence");
        for _ in 0..24_000 {
            measurement.sample(0.0);
        }
        assert!(measurement.quiet());
        measurement.sample(0.01);
        assert!(
            !measurement.quiet(),
            "short residual audio must not average away"
        );
        let mut tone = Measurement::default();
        for index in 0..48_000 {
            tone.sample((index as f64 * std::f64::consts::TAU * 997.0 / 48_000.0).sin() * 0.1);
        }
        assert!((tone.amplitude() - 0.1).abs() < 0.00001);
        assert!(!tone.quiet());
        let mut background = Measurement::default();
        for _ in 0..24_000 {
            background.sample(0.002);
        }
        assert!(
            !background.quiet(),
            "persistent background exceeds the RMS limit"
        );
        background.sample(f64::NAN);
        assert!(
            !background.quiet(),
            "invalid samples cannot establish silence"
        );
        assert!(!std::mem::take(&mut tone).quiet());
        assert_eq!(
            tone.frames, 0,
            "each measurement window starts independently"
        );
    }
}
