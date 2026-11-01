//! Gateway-owned Windows audio provider. Driver provisioning belongs to the
//! installer; commands that inspect configuration/devices never activate it.
use serde::{Deserialize, Serialize};
use stream_kit_audio_target::virtual_device::audio_class::Identity;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial: String,
}

impl Config {
    fn identity(&self) -> Identity {
        Identity {
            vendor: self.vendor_id,
            product: self.product_id,
            serial: self.serial.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.identity().validate()?;
        if !cfg!(target_os = "windows") {
            return Err(
                "virtual_audio is a Windows provider; use native audio provisioning on Linux",
            );
        }
        Ok(())
    }
}

pub struct Runtime {
    #[cfg(target_os = "windows")]
    device: Option<stream_kit_audio_target::virtual_device::lifecycle::ManagedDevice>,
}

impl Runtime {
    pub fn start(config: Option<&Config>) -> std::io::Result<Self> {
        if let Some(config) = config {
            config.validate().map_err(std::io::Error::other)?;
        }
        #[cfg(target_os = "windows")]
        {
            use stream_kit_audio_target::virtual_device::lifecycle::ManagedDevice;
            let device = config
                .map(|config| ManagedDevice::start(config.identity()))
                .transpose()?;
            Ok(Self { device })
        }
        #[cfg(not(target_os = "windows"))]
        Ok(Self {})
    }

    pub fn close(self) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        if let Some(mut device) = self.device {
            device.close()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_provider_does_not_require_a_driver() -> std::io::Result<()> {
        Runtime::start(None)?.close()
    }

    #[test]
    fn identity_must_be_explicit_and_bounded_before_activation() {
        let mut config = Config {
            vendor_id: 0xfffe,
            product_id: 1,
            serial: "TestOnly".into(),
        };
        assert_eq!(config.validate().is_ok(), cfg!(target_os = "windows"));
        for serial in ["", "a-b", "1234567890123456", "麦克风"] {
            config.serial = serial.into();
            assert!(config.validate().is_err());
        }
        config.serial = "TestOnly".into();
        for vendor in [0, 0xffff] {
            config.vendor_id = vendor;
            assert!(Runtime::start(Some(&config)).is_err());
        }
    }
}
