//! Windows virtual recording device implementation under development.
//! The protocol layer does not install a driver, start a listener, or create a
//! recording endpoint. Activation belongs to the managed device lifecycle.
pub mod audio_class;
pub mod engine;
pub mod export;
pub mod transport;
pub mod usbip;
