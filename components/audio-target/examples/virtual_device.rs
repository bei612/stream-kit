//! Developer-only, bounded device lifecycle check. Not part of runtime bundles.
//! Identity is explicit so a test identity cannot become a production default.
#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use stream_kit_audio_target::virtual_device::{
        audio_class::Identity, lifecycle::ManagedDevice,
    };
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("usage: virtual_device VENDOR_ID PRODUCT_ID SERIAL HOLD_SECONDS|stdin".into());
    }
    let duration = if args[3] == "stdin" {
        None
    } else {
        Some(args[3].parse::<u64>()?)
    };
    if duration.is_some_and(|value| !(1..=300).contains(&value)) {
        return Err("hold duration must be 1..300 seconds".into());
    }
    let mut device = ManagedDevice::start(Identity {
        vendor: args[0].parse()?,
        product: args[1].parse()?,
        serial: args[2].clone(),
    })?;
    println!("Virtual audio attached; awaiting Windows endpoint enumeration");
    if let Some(duration) = duration {
        std::thread::sleep(std::time::Duration::from_secs(duration));
    } else {
        // CI owns this pipe. EOF (including an owner crash) closes the device
        // through the production lifecycle, without a force-kill or fixed wait.
        use std::io::Read;
        let mut byte = [0u8; 1];
        while std::io::stdin().read(&mut byte)? != 0 {}
    }
    let running = device.transport_running();
    let devices = stream_kit_audio_target::devices();
    device.close()?;
    if !running {
        return Err("virtual audio transport ended before enumeration".into());
    }
    println!("{}", serde_json::to_string_pretty(&devices?)?);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("The USB audio lifecycle example requires Windows");
    std::process::exit(2);
}
