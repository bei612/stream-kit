//! Explicitly checks a chosen virtual-device pair; never selects system defaults.
use stream_kit_audio_target::{EndpointPair, verification::verify_pair};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err(
            "usage: verify_pair RENDER_DEVICE_ID CAPTURE_DEVICE_ID (plays a test tone)".into(),
        );
    }
    let report = verify_pair(&EndpointPair {
        render_device_id: args[0].clone(),
        capture_device_id: args[1].clone(),
    })?;
    println!("{report}");
    if report["passed"] != true {
        return Err("endpoint pair failed signal delivery or silence verification".into());
    }
    Ok(())
}
