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
    termination: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl Runtime {
    pub fn start(config: Option<&Config>) -> std::io::Result<Self> {
        if let Some(config) = config {
            config.validate().map_err(std::io::Error::other)?;
        }
        #[cfg(target_os = "windows")]
        {
            use stream_kit_audio_target::virtual_device::lifecycle::ManagedDevice;
            let (device, termination) = if let Some(config) = config {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                let device = ManagedDevice::start_observed(config.identity(), move || {
                    let _ = sender.send(());
                })?;
                (Some(device), Some(receiver))
            } else {
                (None, None)
            };
            Ok(Self {
                device,
                termination,
            })
        }
        #[cfg(not(target_os = "windows"))]
        Ok(Self { termination: None })
    }

    pub fn take_termination(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.termination.take()
    }

    pub fn close(self) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        if let Some(mut device) = self.device {
            device.close()?;
        }
        Ok(())
    }
}

/// Let the existing process supervisor recover a failed provider. The HTTP
/// server drains first; Runtime::close then releases the owned attachment and
/// reports the transport error. Disabled providers have no watcher at all.
pub async fn shutdown_signal(
    signal: impl std::future::Future<Output = ()>,
    termination: Option<tokio::sync::oneshot::Receiver<()>>,
) {
    if let Some(termination) = termination {
        tokio::select! {
            _ = signal => {},
            _ = termination => {
                tracing::error!("virtual audio transport ended; stopping gateway for supervised recovery");
            }
        }
    } else {
        signal.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_provider_does_not_require_a_driver() -> std::io::Result<()> {
        Runtime::start(None)?.close()
    }

    #[tokio::test]
    async fn provider_failure_drains_without_waiting_for_an_os_signal() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(()).expect("termination receiver remains open");
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            shutdown_signal(std::future::pending(), Some(receiver)),
        )
        .await
        .expect("transport exit must wake the shutdown future");
    }

    #[tokio::test]
    async fn normal_stop_does_not_wait_for_transport_cleanup() {
        let (_sender, receiver) = tokio::sync::oneshot::channel();
        shutdown_signal(std::future::ready(()), Some(receiver)).await;
        shutdown_signal(std::future::ready(()), None).await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                shutdown_signal(std::future::pending(), None),
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn identity_must_be_explicit_and_bounded_before_activation() {
        let mut config = Config {
            vendor_id: 0xfffe,
            product_id: 1,
            serial: "TestOnly".into(),
        };
        assert_eq!(config.validate().is_ok(), cfg!(target_os = "windows"));
        for serial in ["owner@example.org:StreamKit0123456789", &"a".repeat(126)] {
            config.serial = serial.into();
            assert_eq!(config.validate().is_ok(), cfg!(target_os = "windows"));
        }
        for serial in ["", "bad,serial", "bad/serial", "麦克风", &"a".repeat(127)] {
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
