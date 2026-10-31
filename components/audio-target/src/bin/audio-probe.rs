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

struct Active<S = cpal::Stream> {
    _stream: S,
    kind: &'static str,
    failed: Arc<AtomicBool>,
    frames: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
}

/// Poll each owned stream independently; completion or failure closes only that direction.
fn poll_active<S>(active: &mut Option<Active<S>>) -> (&'static str, u64) {
    let Some(stream) = active.as_ref() else {
        return ("idle", 0);
    };
    let frames = stream.frames.load(Ordering::Relaxed);
    let state = if stream.failed.load(Ordering::Acquire) {
        "failed"
    } else if stream.complete.load(Ordering::Acquire) {
        "completed"
    } else {
        return (stream.kind, frames);
    };
    *active = None;
    (state, frames)
}

fn validate_start(op: &str, input_active: bool, output_active: bool) -> Result<(), String> {
    let input = op == "capture";
    if (input && input_active) || (!input && output_active) {
        return Err("Stop the current test in this direction before starting another".into());
    }
    if op == "playback" && input_active {
        return Err(
            "Stop recording before playing recorded audio; test tone can run during recording"
                .into(),
        );
    }
    Ok(())
}

struct Probe {
    input: Option<Active>,
    output: Option<Active>,
    recording: Arc<Mutex<Recording>>,
    dropped: Arc<AtomicU64>,
    last_error: Option<String>,
}
impl Default for Probe {
    fn default() -> Self {
        Self {
            input: None,
            output: None,
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

#[derive(Default)]
struct PlaybackProgress {
    submitted: usize,
    ends_at: Option<cpal::StreamInstant>,
}

impl PlaybackProgress {
    // A full output buffer is only submitted to the device, not yet played.
    // Keep the stream alive until its clock reaches the final sample's predicted
    // playback time; subsequent callbacks supply silence while the queue drains.
    fn advance(
        &mut self,
        frames: usize,
        total: usize,
        timestamp: cpal::OutputStreamTimestamp,
    ) -> Result<bool, &'static str> {
        let remaining = total.saturating_sub(self.submitted);
        self.submitted += frames.min(remaining);
        if remaining > 0 && self.submitted == total {
            self.ends_at = Some(
                timestamp
                    .playback
                    .checked_add(Duration::from_secs_f64(remaining as f64 / RATE as f64))
                    .ok_or("Playback timestamp overflow")?,
            );
        }
        Ok(self.ends_at.is_some_and(|end| timestamp.callback >= end))
    }
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
    let mut progress = PlaybackProgress::default();
    let callback_failed = failed.clone();
    device.build_output_stream(
        config,
        move |samples: &mut [T], info| {
            for (offset, frame) in samples.chunks_exact_mut(channels).enumerate() {
                frame.fill(T::from_sample_(source.sample(progress.submitted + offset)));
            }
            match progress.advance(samples.len() / channels, source.len(), info.timestamp()) {
                Ok(done) => complete.store(done, Ordering::Release),
                Err(_) => callback_failed.store(true, Ordering::Release),
            }
            frames.store(progress.submitted as u64, Ordering::Relaxed);
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
                if self.input.is_some() {
                    return Err("Stop recording before analyzing recorded audio".into());
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
                self.input = None;
                self.output = None;
                return Ok(self.status());
            }
            "stop_capture" => {
                self.input = None;
                return Ok(self.status());
            }
            "stop_playback" => {
                self.output = None;
                return Ok(self.status());
            }
            "capture" | "tone" | "playback" => {}
            _ => return Err("Unknown probe command".into()),
        }
        let input = command.op == "capture";
        validate_start(&command.op, self.input.is_some(), self.output.is_some())?;
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
        let slot = if input {
            &mut self.input
        } else {
            &mut self.output
        };
        *slot = Some(Active {
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
        let (input_state, _) = poll_active(&mut self.input);
        let (output_state, played) = poll_active(&mut self.output);
        if input_state == "failed" || output_state == "failed" {
            self.last_error = Some("Audio device failed; reselect the device and retry".into());
        }
        let state = if self.input.is_some() && self.output.is_some() {
            "duplex"
        } else if self.input.is_some() {
            input_state
        } else if self.output.is_some() {
            output_state
        } else if input_state == "failed" || output_state == "failed" {
            "failed"
        } else if input_state == "completed" || output_state == "completed" {
            "completed"
        } else {
            "idle"
        };
        let mut data = self.recording.lock().expect("recording lock");
        let rms = (data.square_sum / data.window_frames.max(1) as f64).sqrt();
        let result = json!({"state":state,"input_state":input_state,"output_state":output_state,"captured_frames":data.samples.len(),"played_frames":played,"sample_rate":RATE,"peak":data.peak,"rms":rms,"dropped_frames":self.dropped.load(Ordering::Relaxed),"error":self.last_error});
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
                if probe.input.is_some() || probe.output.is_some() {
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
    fn queued_output_is_not_complete_until_the_device_playback_deadline() {
        let instant = |seconds| {
            cpal::StreamInstant::ZERO
                .checked_add(Duration::from_secs(seconds))
                .unwrap()
        };
        let mut progress = PlaybackProgress::default();
        let timestamp = |callback, playback| cpal::OutputStreamTimestamp {
            callback: instant(callback),
            playback: instant(playback),
        };
        // A backend may request the whole three-second tone in one callback
        // while already holding two seconds of queued audio.
        assert!(
            !progress
                .advance(RATE * 4, RATE * 3, timestamp(0, 2))
                .unwrap()
        );
        assert_eq!(progress.submitted, RATE * 3);
        assert!(!progress.advance(RATE, RATE * 3, timestamp(4, 6)).unwrap());
        assert!(progress.advance(RATE, RATE * 3, timestamp(5, 7)).unwrap());
        assert_eq!(progress.ends_at, Some(instant(5)));
    }

    #[test]
    fn final_partial_buffer_uses_only_remaining_audio_duration() {
        let mut progress = PlaybackProgress::default();
        let at = |seconds| {
            cpal::StreamInstant::ZERO
                .checked_add(Duration::from_secs(seconds))
                .unwrap()
        };
        assert!(
            !progress
                .advance(
                    RATE * 2,
                    RATE * 3,
                    cpal::OutputStreamTimestamp {
                        callback: at(0),
                        playback: at(1),
                    }
                )
                .unwrap()
        );
        assert!(
            !progress
                .advance(
                    RATE * 2,
                    RATE * 3,
                    cpal::OutputStreamTimestamp {
                        callback: at(2),
                        playback: at(3),
                    }
                )
                .unwrap()
        );
        assert_eq!(progress.ends_at, Some(at(4)));
    }

    #[test]
    fn duplex_admission_keeps_directions_independent() {
        assert!(validate_start("capture", false, true).is_ok());
        assert!(validate_start("tone", true, false).is_ok());
        assert!(validate_start("capture", true, false).is_err());
        assert!(validate_start("tone", false, true).is_err());
        assert!(validate_start("playback", true, false).is_err());
        assert!(validate_start("playback", false, false).is_ok());
    }

    #[test]
    fn completion_and_failure_release_only_their_owned_direction() {
        struct Owned(Arc<AtomicBool>);
        impl Drop for Owned {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let input_closed = Arc::new(AtomicBool::new(false));
        let output_closed = Arc::new(AtomicBool::new(false));
        let make = |kind, closed| {
            Some(Active {
                _stream: Owned(closed),
                kind,
                failed: Arc::new(AtomicBool::new(false)),
                frames: Arc::new(AtomicU64::new(960)),
                complete: Arc::new(AtomicBool::new(false)),
            })
        };
        let mut input = make("capture", input_closed.clone());
        let mut output = make("tone", output_closed.clone());
        assert_eq!(poll_active(&mut input), ("capture", 960));
        assert_eq!(poll_active(&mut output), ("tone", 960));
        output
            .as_ref()
            .unwrap()
            .complete
            .store(true, Ordering::Release);
        assert_eq!(poll_active(&mut output), ("completed", 960));
        assert!(output_closed.load(Ordering::Acquire));
        assert!(!input_closed.load(Ordering::Acquire));
        assert_eq!(poll_active(&mut input), ("capture", 960));
        assert_eq!(poll_active(&mut output), ("idle", 0));
        input
            .as_ref()
            .unwrap()
            .failed
            .store(true, Ordering::Release);
        assert_eq!(poll_active(&mut input), ("failed", 960));
        assert!(input_closed.load(Ordering::Acquire));
    }

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
            assert!(probe.input.is_none() && probe.output.is_none());
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
        assert!(probe.input.is_none() && probe.output.is_none());
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
