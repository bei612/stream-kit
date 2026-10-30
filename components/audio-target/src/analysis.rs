//! Bounded, offline analysis of completed probe recordings. Never used in an
//! audio callback or the production media mixer.
use serde::Serialize;

const RATE: usize = 48_000;
const WINDOW: usize = RATE / 10;

#[derive(Debug, Serialize)]
pub struct ToneAnalysis {
    pub frequency_hz: f64,
    pub sample_rate: usize,
    pub analyzed_frames: usize,
    pub windows: usize,
    pub peak_amplitude: f64,
    pub mean_amplitude: f64,
}

/// Measures coherent tone amplitude in non-overlapping 100 ms Hann windows.
/// Peak detects a short test signal; mean also includes recorded silence.
/// This is a diagnostic measurement, not automatic end-to-end acceptance.
pub fn analyze_tone(samples: &[f32], frequency_hz: f64) -> Result<ToneAnalysis, &'static str> {
    if !frequency_hz.is_finite() || !(20.0..=20_000.0).contains(&frequency_hz) {
        return Err("Analysis frequency must be between 20 and 20000 Hz");
    }
    if !(WINDOW..=RATE * 10).contains(&samples.len()) {
        return Err("Analysis requires 100 ms to 10 seconds of recorded audio");
    }
    if samples.iter().any(|value| !value.is_finite()) {
        return Err("Recording contains non-finite samples");
    }
    let coefficient = 2.0 * (std::f64::consts::TAU * frequency_hz / RATE as f64).cos();
    let mut peak: f64 = 0.0;
    let mut sum = 0.0;
    let mut windows = 0;
    for samples in samples.as_chunks::<WINDOW>().0 {
        let (mut previous, mut older, mut weight_sum) = (0.0, 0.0, 0.0);
        for (index, sample) in samples.iter().enumerate() {
            let weight =
                0.5 - 0.5 * (std::f64::consts::TAU * index as f64 / (WINDOW - 1) as f64).cos();
            let current = f64::from(*sample) * weight + coefficient * previous - older;
            older = previous;
            previous = current;
            weight_sum += weight;
        }
        let power = (previous * previous + older * older - coefficient * previous * older).max(0.0);
        let amplitude = 2.0 * power.sqrt() / weight_sum;
        peak = peak.max(amplitude);
        sum += amplitude;
        windows += 1;
    }
    Ok(ToneAnalysis {
        frequency_hz,
        sample_rate: RATE,
        analyzed_frames: windows * WINDOW,
        windows,
        peak_amplitude: peak,
        mean_amplitude: sum / windows as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(hz: f64, amplitude: f64) -> Vec<f32> {
        (0..RATE)
            .map(|i| {
                (amplitude * (std::f64::consts::TAU * hz * i as f64 / RATE as f64 + 0.37).sin())
                    as f32
            })
            .collect()
    }
    #[test]
    fn distinguishes_client_tone_from_program_audio() {
        let mut samples = tone(1499.0, 0.08);
        for (sample, program) in samples.iter_mut().zip(tone(997.0, 0.04)) {
            *sample += program;
        }
        let microphone = analyze_tone(&samples, 1499.0).unwrap();
        let program = analyze_tone(&samples, 997.0).unwrap();
        assert!((microphone.mean_amplitude - 0.08).abs() < 0.001);
        assert!((program.mean_amplitude - 0.04).abs() < 0.001);
        assert!(
            analyze_tone(&tone(997.0, 0.08), 1499.0)
                .unwrap()
                .peak_amplitude
                < 0.0001
        );
    }
    #[test]
    fn reports_silence_and_brief_signal_separately() {
        let mut samples = vec![0.0; RATE];
        assert_eq!(analyze_tone(&samples, 1499.0).unwrap().peak_amplitude, 0.0);
        samples[..WINDOW].copy_from_slice(&tone(1499.0, 0.08)[..WINDOW]);
        let result = analyze_tone(&samples, 1499.0).unwrap();
        assert!((result.peak_amplitude - 0.08).abs() < 0.001);
        assert!((result.mean_amplitude - 0.008).abs() < 0.001);
    }
    #[test]
    fn rejects_invalid_frequency_and_recording_bounds() {
        for hz in [f64::NAN, f64::INFINITY, 0.0, 24000.0] {
            assert!(analyze_tone(&[0.0; WINDOW], hz).is_err());
        }
        assert!(analyze_tone(&[], 1499.0).is_err());
        assert!(analyze_tone(&vec![0.0; RATE * 10 + 1], 1499.0).is_err());
        assert!(analyze_tone(&[f32::NAN; WINDOW], 1499.0).is_err());
    }
}
