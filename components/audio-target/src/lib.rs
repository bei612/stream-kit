//! Native rendering-node microphone output. A route names both sides of a
//! provisioned virtual device; opening it never changes system default devices.
mod pcm;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    #[error("endpoint must support 48 kHz mono/stereo PCM (f32/i16/i32)")]
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

#[derive(Debug, Serialize)]
pub struct TargetStatus {
    pub device_open: bool,
    pub device_sample_frames: u64,
    pub dropped_frames: u64,
    pub xruns: u64,
    pub realtime_denied: bool,
    pub error: Option<String>,
    // Callback consumption is not proof that the target application recorded it.
}

#[derive(Default)]
struct Shared {
    queue: Mutex<pcm::PcmQueue>,
    open: AtomicBool,
    failed: AtomicBool,
    consumed: AtomicU64,
    dropped: AtomicU64,
    xruns: AtomicU64,
    realtime_denied: AtomicBool,
    error: Mutex<Option<String>>,
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
        let config = device
            .supported_output_configs()?
            .find(|config| {
                (1..=2).contains(&config.channels())
                    && config.min_sample_rate() <= 48_000
                    && config.max_sample_rate() >= 48_000
                    && matches!(
                        config.sample_format(),
                        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
                    )
            })
            .ok_or(Error::UnsupportedFormat)?
            .with_sample_rate(48_000);
        let shared = Arc::new(Shared::default());
        let frames = match *config.buffer_size() {
            cpal::SupportedBufferSize::Range { min, max } if min <= 960 => 960.min(max),
            cpal::SupportedBufferSize::Unknown => 960,
            _ => return Err(Error::UnsupportedFormat),
        };
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
        shared.open.store(true, Ordering::Release);
        Ok(Self {
            _stream: stream,
            shared,
        })
    }

    /// One 20 ms, 48 kHz interleaved stereo frame from the authorized session bus.
    pub fn submit(&self, samples: &[f32]) -> bool {
        if self.shared.failed.load(Ordering::Acquire) {
            return false;
        }
        let result = self
            .shared
            .queue
            .try_lock()
            .ok()
            .and_then(|mut queue| queue.push(samples, Instant::now()));
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

impl Shared {
    fn status(&self) -> TargetStatus {
        TargetStatus {
            device_open: self.open.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire),
            device_sample_frames: self.consumed.load(Ordering::Relaxed),
            dropped_frames: self.dropped.load(Ordering::Relaxed),
            xruns: self.xruns.load(Ordering::Relaxed),
            realtime_denied: self.realtime_denied.load(Ordering::Relaxed),
            error: self.error.lock().ok().and_then(|error| error.clone()),
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
