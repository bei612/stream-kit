fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        serde_json::to_string_pretty(&stream_kit_audio_target::devices()?)?
    );
    Ok(())
}
