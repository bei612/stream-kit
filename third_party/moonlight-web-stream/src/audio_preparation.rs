//! Platform-owned device initialization over private process pipes. No web
//! server, audio streams or diagnostics are started by this operation.
use crate::virtual_audio::Config;
use std::io::{self, BufRead, IsTerminal, Read, Write};

pub fn run(config: Option<&Config>) -> io::Result<()> {
    if io::stdin().is_terminal() {
        return Err(io::Error::other(
            "audio preparation requires a platform-owned input pipe",
        ));
    }
    if let Some(config) = config {
        config.validate().map_err(io::Error::other)?;
    }
    let mut output = io::stdout().lock();
    writeln!(
        output,
        "{}",
        serde_json::json!({"schema_version": 1, "identity": config})
    )?;
    output.flush()?;
    let Some(config) = config else {
        return Ok(());
    };
    let mut input = io::stdin().lock();
    if !command(&mut input)? {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use stream_kit_audio_target::virtual_device::lifecycle::ManagedDevice;
        let mut device = ManagedDevice::start(config.identity())?;
        writeln!(
            output,
            "{}",
            serde_json::json!({"schema_version": 1, "attached": true})
        )?;
        output.flush()?;
        // The owner closes stdin after policy preparation. EOF also handles
        // owner failure; dropping the managed device releases its attachment.
        if command(&mut input)? {
            return Err(io::Error::other(
                "audio preparation accepts only one attachment",
            ));
        }
        device.close()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = config;
        Err(io::Error::other(
            "USB audio preparation is available on Windows only",
        ))
    }
}

fn command(input: &mut impl BufRead) -> io::Result<bool> {
    let mut value = String::new();
    let count = input.take(32).read_line(&mut value)?;
    match (count, value.as_str()) {
        (0, _) => Ok(false),
        (_, "attach\n") => Ok(true),
        _ => Err(io::Error::other(
            "invalid bounded audio preparation command",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_commands_keep_eof_distinct_from_activation() -> io::Result<()> {
        assert!(!command(&mut &b""[..])?);
        assert!(command(&mut &b"attach\n"[..])?);
        for input in ["attach", "close\n", "\n", &"a".repeat(10000)] {
            assert!(command(&mut input.as_bytes()).is_err());
        }
        let mut input = &b"attach\nattach\n"[..];
        assert!(command(&mut input)?);
        assert!(command(&mut input)?);
        assert!(!command(&mut input)?);
        Ok(())
    }
}
