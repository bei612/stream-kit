//! Native rendering-node microphone output. A route names both sides of a
//! provisioned virtual device; opening it never changes system default devices.
pub mod admission;
pub mod analysis;
mod pcm;
pub mod verification;
pub mod wire;

use cpal::{
    DeviceId, SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
pub use pcm::FRAME_SAMPLES;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointPair {
    /// Stable CPAL output ID of the provisioned virtual cable/sink.
    pub render_device_id: String,
    /// Stable recording ID the target application is configured to consume.
    pub capture_device_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("audio platform: {0}")]
    Platform(#[from] cpal::Error),
    #[error("configured {0} endpoint is unavailable")]
    Missing(&'static str),
    #[error(
        "endpoint must support 48 kHz mono/stereo PCM (f32/i16/i32) with a buffer of at most 20 ms"
    )]
    UnsupportedFormat,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub input: bool,
    pub output: bool,
}

/// Enumerates only; it does not open streams or install/modify audio devices.
pub fn devices() -> Result<Vec<DeviceInfo>, Error> {
    let mut result = Vec::new();
    for host_id in cpal::available_hosts() {
        let host = cpal::host_from_id(host_id)?;
        for device in host.devices()? {
            result.push(DeviceInfo {
                id: device.id()?.to_string(),
                name: device.description()?.name().to_owned(),
                input: device.supports_input(),
                output: device.supports_output(),
            });
        }
    }
    Ok(result)
}

#[derive(Clone, Debug, Serialize)]
pub struct TargetStatus {
    pub device_open: bool,
    pub device_sample_frames: u64,
    pub dropped_frames: u64,
    pub xruns: u64,
    pub realtime_denied: bool,
    pub error: Option<String>,
    // Callback consumption is not proof that the target application recorded it.
}

struct Shared {
    clock: Instant,
    last_callback_ms: AtomicU64,
    queue: Mutex<pcm::PcmQueue>,
    open: AtomicBool,
    failed: AtomicBool,
    consumed: AtomicU64,
    dropped: AtomicU64,
    xruns: AtomicU64,
    realtime_denied: AtomicBool,
    error: Mutex<Option<String>>,
}

// This detects a silent native backend stall, not individual audio underruns.
// It is evaluated only when existing status consumers request a snapshot.
const CALLBACK_TIMEOUT_MS: u64 = 2_000;

impl Default for Shared {
    fn default() -> Self {
        Self {
            clock: Instant::now(),
            last_callback_ms: AtomicU64::new(0),
            queue: Mutex::default(),
            open: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            consumed: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            xruns: AtomicU64::new(0),
            realtime_denied: AtomicBool::new(false),
            error: Mutex::default(),
        }
    }
}

pub struct AudioTarget {
    _stream: cpal::Stream,
    shared: Arc<Shared>,
}

/// Read-only telemetry never owns the native stream or extends its lifetime.
#[derive(Clone)]
pub struct TargetMonitor {
    shared: Arc<Shared>,
}

impl TargetMonitor {
    pub fn status(&self) -> TargetStatus {
        self.shared.status()
    }
}

impl AudioTarget {
    pub fn open(pair: &EndpointPair) -> Result<Self, Error> {
        let render_id: DeviceId = pair.render_device_id.parse()?;
        let capture_id: DeviceId = pair.capture_device_id.parse()?;
        let capture_host = cpal::host_from_id(capture_id.host())?;
        let capture = capture_host
            .device_by_id(&capture_id)
            .ok_or(Error::Missing("capture"))?;
        if !capture.supports_input() {
            return Err(Error::Missing("capture"));
        }
        let host = cpal::host_from_id(render_id.host())?;
        let device = host
            .device_by_id(&render_id)
            .ok_or(Error::Missing("render"))?;
        let (config, frames) = select_output_config(device.supported_output_configs()?)?;
        let shared = Arc::new(Shared::default());
        let format = config.sample_format();
        let mut config: cpal::StreamConfig = config.into();
        config.buffer_size = cpal::BufferSize::Fixed(frames);
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, shared.clone())?,
            SampleFormat::I16 => build::<i16>(&device, config, shared.clone())?,
            SampleFormat::I32 => build::<i32>(&device, config, shared.clone())?,
            _ => return Err(Error::UnsupportedFormat),
        };
        stream.play()?;
        shared.record_callback(); // Start the first-callback grace period at play.
        shared.open.store(true, Ordering::Release);
        Ok(Self {
            _stream: stream,
            shared,
        })
    }

    /// One 20 ms, 48 kHz interleaved stereo frame from the authorized session bus.
    pub fn submit(&self, samples: &[f32]) -> bool {
        self.submit_captured(samples, Instant::now())
    }

    /// Submit with the original capture/ingress instant. Remote receivers must
    /// subtract the verified source age from their receipt instant, including
    /// decode/dispatch time in the remaining lifetime. Never refresh on retry.
    /// Reject expired/future timestamps without evicting valid queued audio.
    pub fn submit_captured(&self, samples: &[f32], captured: Instant) -> bool {
        if self.shared.failed.load(Ordering::Acquire) {
            return false;
        }
        let result = self
            .shared
            .queue
            .try_lock()
            .ok()
            .and_then(|mut queue| queue.push(samples, captured, Instant::now()));
        if result != Some(false) {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
        result.is_some()
    }
    pub fn clear(&self) {
        if let Ok(mut queue) = self.shared.queue.lock() {
            queue.clear();
        }
    }
    pub fn status(&self) -> TargetStatus {
        self.shared.status()
    }
    pub fn monitor(&self) -> TargetMonitor {
        TargetMonitor {
            shared: self.shared.clone(),
        }
    }
}

/// Validate format and callback buffer together before selecting an advertised
/// configuration. An unusable first range must not hide a later usable range.
fn select_output_config(
    configurations: impl IntoIterator<Item = cpal::SupportedStreamConfigRange>,
) -> Result<(cpal::SupportedStreamConfig, u32), Error> {
    configurations
        .into_iter()
        .find_map(|config| {
            if !(1..=2).contains(&config.channels())
                || config.min_sample_rate() > 48_000
                || config.max_sample_rate() < 48_000
                || !matches!(
                    config.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
                )
            {
                return None;
            }
            let frames = match *config.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max }
                    if min <= max && max > 0 && min <= 960 =>
                {
                    960.min(max)
                }
                cpal::SupportedBufferSize::Unknown => 960,
                _ => return None,
            };
            Some((config.with_sample_rate(48_000), frames))
        })
        .ok_or(Error::UnsupportedFormat)
}

impl Shared {
    fn record_callback(&self) {
        self.last_callback_ms
            .store(self.clock.elapsed().as_millis() as u64, Ordering::Release);
    }

    fn status(&self) -> TargetStatus {
        self.status_at(self.clock.elapsed().as_millis() as u64)
    }

    fn status_at(&self, now_ms: u64) -> TargetStatus {
        let open = self.open.load(Ordering::Acquire);
        let error = self.error.lock().ok().and_then(|error| error.clone());
        let stalled = open
            && now_ms.saturating_sub(self.last_callback_ms.load(Ordering::Acquire))
                > CALLBACK_TIMEOUT_MS;
        TargetStatus {
            device_open: self.open.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire),
            device_sample_frames: self.consumed.load(Ordering::Relaxed),
            dropped_frames: self.dropped.load(Ordering::Relaxed),
            xruns: self.xruns.load(Ordering::Relaxed),
            realtime_denied: self.realtime_denied.load(Ordering::Relaxed),
            error: error.or_else(|| stalled.then(|| "audio output callback stalled".to_owned())),
        }
    }
}
impl Drop for AudioTarget {
    fn drop(&mut self) {
        self.shared.open.store(false, Ordering::Release);
        self.clear();
    }
}

fn build<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, Error> {
    let channels = config.channels as usize;
    let errors = shared.clone();
    Ok(device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            // Real-time callbacks must never block, allocate, or log.
            shared.record_callback();
            data.fill(T::from_sample(0.0));
            if shared.failed.load(Ordering::Acquire) {
                return;
            }
            let Ok(mut queue) = shared.queue.try_lock() else {
                return;
            };
            let now = Instant::now();
            for frame in data.chunks_exact_mut(channels) {
                let [left, right] = queue.stereo(now);
                if channels == 1 {
                    frame[0] = T::from_sample((left + right) * 0.5);
                } else {
                    frame[0] = T::from_sample(left);
                    frame[1] = T::from_sample(right);
                }
            }
            shared
                .consumed
                .fetch_add((data.len() / channels) as u64, Ordering::Relaxed);
        },
        move |error| {
            record_error(&errors, error);
        },
        None,
    )?)
}

fn record_error(shared: &Shared, error: cpal::Error) {
    match error.kind() {
        cpal::ErrorKind::Xrun => {
            shared.xruns.fetch_add(1, Ordering::Relaxed);
        }
        cpal::ErrorKind::RealtimeDenied => {
            shared.realtime_denied.store(true, Ordering::Relaxed);
        }
        _ => {
            shared.failed.store(true, Ordering::Release);
            if let Ok(mut message) = shared.error.lock() {
                *message = Some(error.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_liveness_reports_silent_stalls_and_recovery() {
        let shared = Shared::default();
        assert!(shared.status_at(10_000).error.is_none());
        shared.open.store(true, Ordering::Release);
        shared.last_callback_ms.store(100, Ordering::Release);
        assert!(shared.status_at(2_100).error.is_none());
        let stalled = shared.status_at(2_101);
        assert!(stalled.device_open); // Ownership is distinct from liveness.
        assert_eq!(
            stalled.error.as_deref(),
            Some("audio output callback stalled")
        );
        shared.last_callback_ms.store(2_101, Ordering::Release);
        assert!(shared.status_at(2_102).error.is_none());
        // A callback may advance after the status reader samples its clock.
        assert!(shared.status_at(2_100).error.is_none());
        shared.open.store(false, Ordering::Release);
        let closed = shared.status_at(20_000);
        assert!(!closed.device_open);
        assert!(closed.error.is_none());
    }

    #[test]
    fn native_failure_takes_precedence_over_stalled_callback() {
        let shared = Shared::default();
        shared.open.store(true, Ordering::Release);
        record_error(&shared, cpal::ErrorKind::StreamInvalidated.into());
        let original = shared.status_at(0).error.expect("native error");
        let stalled = shared.status_at(10_000);
        assert!(!stalled.device_open);
        assert_eq!(stalled.error.as_deref(), Some(original.as_str()));
        shared.record_callback();
        assert!(!shared.status().device_open);
        assert_eq!(shared.status().error.as_deref(), Some(original.as_str()));
    }

    #[test]
    fn later_usable_device_configuration_is_not_hidden_by_large_first_buffer() {
        let configurations = [
            cpal::SupportedStreamConfigRange::new(
                2,
                48_000,
                48_000,
                cpal::SupportedBufferSize::Range {
                    min: 2048,
                    max: 4096,
                },
                SampleFormat::F32,
            ),
            cpal::SupportedStreamConfigRange::new(
                2,
                44_100,
                96_000,
                cpal::SupportedBufferSize::Range { min: 128, max: 512 },
                SampleFormat::I16,
            ),
        ];
        let (selected, frames) = select_output_config(configurations).expect("usable second range");
        assert_eq!(selected.sample_format(), SampleFormat::I16);
        assert_eq!(selected.sample_rate(), 48_000);
        assert_eq!(frames, 512);
    }

    #[test]
    fn invalid_or_excessive_buffers_are_not_opened() {
        for (min, max) in [(0, 0), (512, 128), (961, 2048)] {
            let config = cpal::SupportedStreamConfigRange::new(
                2,
                48_000,
                48_000,
                cpal::SupportedBufferSize::Range { min, max },
                SampleFormat::F32,
            );
            assert!(select_output_config([config]).is_err());
        }
    }
    #[test]
    fn missing_ids_are_not_replaced_by_default_devices() {
        for (render, capture) in [("", ""), ("invalid", "invalid")] {
            assert!(
                AudioTarget::open(&EndpointPair {
                    render_device_id: render.into(),
                    capture_device_id: capture.into(),
                })
                .is_err()
            );
        }
    }
    #[test]
    fn native_target_is_safe_to_own_in_a_session_task() {
        fn require<T: Send + Sync>() {}
        require::<AudioTarget>();
    }
    #[test]
    fn recoverable_device_events_do_not_silently_stop_microphone() {
        let shared = Shared::default();
        record_error(&shared, cpal::ErrorKind::Xrun.into());
        record_error(&shared, cpal::ErrorKind::RealtimeDenied.into());
        assert!(!shared.failed.load(Ordering::Acquire));
        assert_eq!(shared.xruns.load(Ordering::Relaxed), 1);
        assert!(shared.realtime_denied.load(Ordering::Relaxed));
        record_error(&shared, cpal::ErrorKind::StreamInvalidated.into());
        assert!(shared.failed.load(Ordering::Acquire));
    }
}
