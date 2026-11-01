//! Windows virtual recording device implementation under development.
//! The protocol layer does not install a driver, start a listener, or create a
//! recording endpoint. Activation belongs to the managed device lifecycle.
pub mod audio_class;
#[cfg(target_os = "windows")]
pub mod controller;
mod deadline_channel;
pub mod engine;
pub mod export;
#[cfg(target_os = "windows")]
pub mod lifecycle;
pub mod transport;
pub mod usbip;
