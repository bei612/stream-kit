//! Example-owned audio diagnostics. JSON-lines over inherited pipes only.
//! No device opens until an explicit command; EOF releases every stream.
use cpal::{
    DeviceId, SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

const RATE: usize = 48_000;
const MAX_FRAMES: usize = RATE * 10;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    schema_version: u32,
    id: u64,
    op: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    frequency_hz: Option<f64>,
}

#[derive(Default)]
struct Recording {
    samples: Vec<f32>,
    peak: f32,
    square_sum: f64,
    window_frames: u64,
}
impl Recording {
    fn new() -> Self {
        Self {
            samples: Vec::with_capacity(MAX_FRAMES),
            ..Self::default()
        }
    }
    fn consume<T: cpal::SizedSample>(&mut self, samples: &[T], channels: usize)
    where
        f32: cpal::FromSample<T>,
    {
        for frame in samples.chunks_exact(channels) {
            if self.samples.len() == MAX_FRAMES {
                break;
            }
            let mono = frame
                .iter()
                .map(|s| <f32 as cpal::FromSample<T>>::from_sample_(*s))
                .sum::<f32>()
                / channels as f32;
            let mono = if mono.is_finite() {
                mono.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            self.samples.push(mono);
            self.peak = self.peak.max(mono.abs());
            self.square_sum += f64::from(mono) * f64::from(mono);
            self.window_frames += 1;
        }
    }
}

struct Active {
    _stream: cpal::Stream,
    kind: &'static str,
    failed: Arc<AtomicBool>,
    frames: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
}
struct Probe {
    active: Option<Active>,
    recording: Arc<Mutex<Recording>>,
    dropped: Arc<AtomicU64>,
    last_error: Option<String>,
}
impl Default for Probe {
    fn default() -> Self {
        Self {
            active: None,
            recording: Arc::new(Mutex::new(Recording::new())),
            dropped: Arc::new(AtomicU64::new(0)),
            last_error: None,
        }
    }
}

fn device_config(
    id: &str,
    input: bool,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    if id.is_empty() {
        return Err("Select an explicit audio device first".into());
    }
    let id: DeviceId = id.parse().map_err(|e: cpal::Error| e.to_string())?;
    let host = cpal::host_from_id(id.host()).map_err(|e| e.to_string())?;
    let device = host
        .device_by_id(&id)
        .ok_or("Selected audio device is unavailable")?;
    let configs: Vec<_> = if input {
        device
            .supported_input_configs()
            .map_err(|e| e.to_string())?
            .collect()
    } else {
        device
            .supported_output_configs()
            .map_err(|e| e.to_string())?
            .collect()
    };
    let config = configs
        .into_iter()
        .find(|c| {
            (1..=2).contains(&c.channels())
                && c.min_sample_rate() <= RATE as u32
                && c.max_sample_rate() >= RATE as u32
                && matches!(
                    c.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
                )
        })
        .ok_or("Device must support 48 kHz mono/stereo f32, i16 or i32")?
        .with_sample_rate(RATE as u32);
    Ok((device, config))
}

fn capture<T: cpal::SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    recording: Arc<Mutex<Recording>>,
    dropped: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
    complete: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::Error>
where
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    device.build_input_stream(
        config,
        move |samples: &[T], _| {
            if let Ok(mut recording) = recording.try_lock() {
                recording.consume(samples, channels);
                if recording.samples.len() == MAX_FRAMES {
                    complete.store(true, Ordering::Release);
                }
            } else {
                dropped.fetch_add((samples.len() / channels) as u64, Ordering::Relaxed);
            }
        },
        move |_| {
            failed.store(true, Ordering::Release);
        },
        None,
    )
}

enum Playback {
    Tone,
    Recorded(Vec<f32>),
}
impl Playback {
    fn len(&self) -> usize {
        match self {
            Self::Tone => RATE * 3,
            Self::Recorded(s) => s.len(),
        }
    }
    fn sample(&self, index: usize) -> f32 {
        if index >= self.len() {
            return 0.0;
        }
        match self {
            Self::Tone => {
                let fade = (index.min(self.len() - index) as f32 / 480.0).min(1.0);
                (index as f64 * std::f64::consts::TAU * 997.0 / RATE as f64).sin() as f32
                    * 0.08
                    * fade
            }
            Self::Recorded(samples) => samples[index] * 0.5,
        }
    }
}
fn output<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    source: Playback,
    failed: Arc<AtomicBool>,
    frames: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::Error> {
    let channels = config.channels as usize;
    let mut index = 0;
    device.build_output_stream(
        config,
        move |samples: &mut [T], _| {
            for frame in samples.chunks_exact_mut(channels) {
                frame.fill(T::from_sample_(source.sample(index)));
                index += 1;
            }
            frames.store(index.min(source.len()) as u64, Ordering::Relaxed);
            if index >= source.len() {
                complete.store(true, Ordering::Release);
            }
        },
        move |_| {
            failed.store(true, Ordering::Release);
        },
        None,
    )
}

impl Probe {
    fn execute(&mut self, command: &Command) -> Result<Value, String> {
        if command.schema_version != 1 {
            return Err("Unsupported probe protocol version".into());
        }
        match command.op.as_str() {
            "devices" => {
                return stream_kit_audio_target::devices()
                    .map(|d| json!({"devices":d}))
                    .map_err(|e| e.to_string());
            }
            "status" => return Ok(self.status()),
            "analyze" => {
                if self.active.is_some() {
                    return Err("Stop the current test before analyzing recorded audio".into());
                }
                let frequency = command
                    .frequency_hz
                    .ok_or("Specify an analysis frequency")?;
                let recording = self.recording.lock().map_err(|_| "Recording unavailable")?;
                let analysis =
                    stream_kit_audio_target::analysis::analyze_tone(&recording.samples, frequency)
                        .map_err(str::to_owned)?;
                return Ok(json!(analysis));
            }
            "stop" => {
                self.active = None;
                return Ok(self.status());
            }
            "capture" | "tone" | "playback" => {}
            _ => return Err("Unknown probe command".into()),
        }
        if self.active.is_some() {
            return Err("Stop the current test before starting another".into());
        }
        let input = command.op == "capture";
        let (device, config) = device_config(&command.device_id, input)?;
        let failed = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(AtomicU64::new(0));
        let complete = Arc::new(AtomicBool::new(false));
        let stream = if input {
            self.recording = Arc::new(Mutex::new(Recording::new()));
            self.dropped.store(0, Ordering::Relaxed);
            macro_rules! open {
                ($t:ty) => {
                    capture::<$t>(
                        &device,
                        config.into(),
                        self.recording.clone(),
                        self.dropped.clone(),
                        failed.clone(),
                        complete.clone(),
                    )
                };
            }
            match config.sample_format() {
                SampleFormat::F32 => open!(f32),
                SampleFormat::I16 => open!(i16),
                SampleFormat::I32 => open!(i32),
                _ => unreachable!(),
            }
        } else {
            let source = if command.op == "tone" {
                Playback::Tone
            } else {
                let data = self.recording.lock().map_err(|_| "Recording unavailable")?;
                if data.samples.is_empty() {
                    return Err("Record microphone input before playback".into());
                }
                Playback::Recorded(data.samples.clone())
            };
            macro_rules! open {
                ($t:ty) => {
                    output::<$t>(
                        &device,
                        config.into(),
                        source,
                        failed.clone(),
                        frames.clone(),
                        complete.clone(),
                    )
                };
            }
            match config.sample_format() {
                SampleFormat::F32 => open!(f32),
                SampleFormat::I16 => open!(i16),
                SampleFormat::I32 => open!(i32),
                _ => unreachable!(),
            }
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        self.last_error = None;
        self.active = Some(Active {
            _stream: stream,
            kind: if input {
                "capture"
            } else if command.op == "tone" {
                "tone"
            } else {
                "playback"
            },
            failed,
            frames,
            complete,
        });
        Ok(self.status())
    }
    fn status(&mut self) -> Value {
        let mut state = "idle";
        let mut played = 0;
        if let Some(active) = &self.active {
            state = active.kind;
            played = active.frames.load(Ordering::Relaxed);
            if active.failed.load(Ordering::Acquire) {
                self.last_error = Some("Audio device failed; reselect the device and retry".into());
                self.active = None;
                state = "failed";
            } else if active.complete.load(Ordering::Acquire) {
                self.active = None;
                state = "completed";
            }
        }
        let mut data = self.recording.lock().expect("recording lock");
        let rms = (data.square_sum / data.window_frames.max(1) as f64).sqrt();
        let result = json!({"state":state,"captured_frames":data.samples.len(),"played_frames":played,"sample_rate":RATE,"peak":data.peak,"rms":rms,"dropped_frames":self.dropped.load(Ordering::Relaxed),"error":self.last_error});
        data.peak = 0.0;
        data.square_sum = 0.0;
        data.window_frames = 0;
        result
    }
}

fn emit(id: u64, event: &str, result: Result<Value, String>) -> io::Result<()> {
    let line = match result {
        Ok(data) => json!({"schema_version":1,"id":id,"event":event,"data":data}),
        Err(error) => json!({"schema_version":1,"id":id,"event":event,"error":error}),
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &line)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}
fn main() -> io::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            // Limit commands before allocation; an oversized frame terminates IPC.
            match input.by_ref().take(16_385).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 16_384 => break,
                Ok(_) => {
                    if sender
                        .send(serde_json::from_slice::<Command>(&line).map_err(|e| e.to_string()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    let mut probe = Probe::default();
    loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(command)) => emit(command.id, "response", probe.execute(&command))?,
            Ok(Err(error)) => emit(0, "response", Err(error))?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if probe.active.is_some() {
                    emit(0, "status", Ok(probe.status()))?;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recording_is_bounded_and_measures_actual_pcm() {
        let mut r = Recording::new();
        r.consume(&[0.5_f32, 0.25, -0.5, -0.25], 2);
        assert_eq!(r.samples, vec![0.375, -0.375]);
        assert_eq!(r.peak, 0.375);
        r.consume(&vec![0.1_f32; MAX_FRAMES * 2], 1);
        assert_eq!(r.samples.len(), MAX_FRAMES);
        assert_eq!(r.samples.capacity(), MAX_FRAMES);
    }
    #[test]
    fn explicit_device_and_protocol_required_without_opening_defaults() {
        let mut probe = Probe::default();
        for (version, op, id) in [
            (2, "capture", ""),
            (1, "capture", ""),
            (1, "tone", ""),
            (1, "unknown", ""),
        ] {
            assert!(
                probe
                    .execute(&Command {
                        schema_version: version,
                        id: 1,
                        op: op.into(),
                        device_id: id.into(),
                        frequency_hz: None,
                    })
                    .is_err()
            );
            assert!(probe.active.is_none());
        }
    }
    #[test]
    fn recording_analysis_uses_pcm_without_opening_an_audio_device() {
        let mut probe = Probe::default();
        let command = Command {
            schema_version: 1,
            id: 1,
            op: "analyze".into(),
            device_id: String::new(),
            frequency_hz: Some(997.0),
        };
        assert!(probe.execute(&command).is_err());
        let samples: Vec<f32> = (0..RATE).map(|i| Playback::Tone.sample(i)).collect();
        probe.recording.lock().unwrap().consume(&samples, 1);
        let result = probe.execute(&command).unwrap();
        assert_eq!(result["analyzed_frames"], RATE);
        assert!(result["peak_amplitude"].as_f64().unwrap() > 0.079);
        assert!(probe.active.is_none());
        assert_eq!(probe.recording.lock().unwrap().samples.len(), RATE);
    }
    #[test]
    fn output_has_fixed_duration_bounded_level_and_silent_tail() {
        let tone = Playback::Tone;
        assert_eq!(tone.len(), RATE * 3);
        assert_eq!(tone.sample(0), 0.0);
        assert_eq!(tone.sample(tone.len()), 0.0);
        assert!((0..tone.len()).all(|i| tone.sample(i).abs() <= 0.08));
        assert_eq!(Playback::Recorded(vec![1.0, -1.0]).sample(1), -0.5);
    }
}
