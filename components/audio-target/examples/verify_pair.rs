//! Explicit endpoint acceptance: emits a quiet 997 Hz test tone into the named
//! render device and verifies it on the named capture device. Never selects defaults.
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
use stream_kit_audio_target::{AudioTarget, EndpointPair, FRAME_SAMPLES};

#[derive(Default)]
struct Measurement {
    frames: u64,
    sine: f64,
    cosine: f64,
    energy: f64,
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
                    let phase = result.frames as f64 * std::f64::consts::TAU * 997.0 / 48_000.0;
                    result.sine += sample * phase.sin();
                    result.cosine += sample * phase.cos();
                    result.energy += sample * sample;
                    result.frames += 1;
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err(
            "usage: verify_pair RENDER_DEVICE_ID CAPTURE_DEVICE_ID (plays a test tone)".into(),
        );
    }
    let pair = EndpointPair {
        render_device_id: args[0].clone(),
        capture_device_id: args[1].clone(),
    };
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
    let target = AudioTarget::open(&pair)?;
    stream.play()?;
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
    std::thread::sleep(Duration::from_millis(300));
    stream.pause()?;
    let result = result.lock().map_err(|_| "capture measurement poisoned")?;
    let amplitude = 2.0 * result.sine.hypot(result.cosine) / result.frames.max(1) as f64;
    let status = target.status();
    let passed = submitted >= 140
        && result.frames > 48_000
        && amplitude > 0.01
        && status.device_open
        && !failed.load(Ordering::Acquire);
    println!(
        "{}",
        serde_json::json!({"passed": passed, "captured_frames": result.frames,
        "tone_amplitude": amplitude, "submitted_packets": submitted, "target": status})
    );
    if !passed {
        return Err("endpoint pair did not reproduce the test signal".into());
    }
    Ok(())
}
