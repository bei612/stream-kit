//! Native target ownership and asynchronous replacement. The media clock only
//! changes desired state and submits PCM; native open/drop never runs there.
use super::SessionSlot;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};
use stream_kit_audio_target::{AudioTarget, EndpointPair, TargetStatus};
use tokio::sync::{OwnedMutexGuard, oneshot};
#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;

pub(super) trait OutputDevice: Send + 'static {
    fn clear(&self);
    fn submit(&self, samples: &[f32], captured: Instant);
    fn status(&self) -> TargetStatus;
}
impl OutputDevice for AudioTarget {
    fn clear(&self) {
        self.clear();
    }
    fn submit(&self, samples: &[f32], captured: Instant) {
        self.submit_captured(samples, captured);
    }
    fn status(&self) -> TargetStatus {
        self.status()
    }
}

#[derive(Clone, Default)]
pub(super) struct EndpointRegistry(Arc<Mutex<HashSet<String>>>);
struct Reservation {
    registry: EndpointRegistry,
    pair: EndpointPair,
}
impl EndpointRegistry {
    pub(super) fn verify_pair(&self, pair: &EndpointPair) -> Result<serde_json::Value, String> {
        let _reservation = self.reserve(pair)?;
        stream_kit_audio_target::verification::verify_pair(pair).map_err(|error| error.to_string())
    }

    fn reserve(&self, pair: &EndpointPair) -> Result<Reservation, String> {
        let mut used = self.0.lock().expect("endpoint registry poisoned");
        if pair.render_device_id == pair.capture_device_id
            || used.contains(&pair.render_device_id)
            || used.contains(&pair.capture_device_id)
        {
            return Err("audio endpoint is still owned by another native operation".into());
        }
        used.insert(pair.render_device_id.clone());
        used.insert(pair.capture_device_id.clone());
        Ok(Reservation {
            registry: self.clone(),
            pair: pair.clone(),
        })
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut used = self.registry.0.lock().expect("endpoint registry poisoned");
        used.remove(&self.pair.render_device_id);
        used.remove(&self.pair.capture_device_id);
    }
}
pub(super) struct NativeOutput {
    device: AudioTarget,
    _reservation: Reservation,
}
impl OutputDevice for NativeOutput {
    fn clear(&self) {
        self.device.clear();
    }
    fn submit(&self, samples: &[f32], captured: Instant) {
        self.device.submit_captured(samples, captured);
    }
    fn status(&self) -> TargetStatus {
        self.device.status()
    }
}

// Native destruction precedes release of the mutex and session index lifetime.
struct Resource<D> {
    device: D,
    lifetime: Lifetime,
}
struct Lifetime {
    _permit: OwnedMutexGuard<()>,
    _slot: Arc<SessionSlot>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Snapshot {
    pub epoch: u64,
    pub pending: bool,
    pub device: Option<TargetStatus>,
    pub error: Option<String>,
}

#[derive(Clone, Default)]
pub(super) struct Monitor(Arc<Mutex<Snapshot>>);
impl Monitor {
    pub fn snapshot(&self) -> Snapshot {
        self.0.lock().expect("target monitor poisoned").clone()
    }
    fn set(&self, snapshot: Snapshot) {
        *self.0.lock().expect("target monitor poisoned") = snapshot;
    }
}

type Open<D> = Arc<dyn Fn(&EndpointPair) -> Result<D, String> + Send + Sync>;
type Prepared<D> = Result<Option<Resource<D>>, String>;
#[derive(Clone, PartialEq, Eq)]
struct Selection {
    epoch: u64,
    endpoint: Option<EndpointPair>,
}
struct Pending<D: Send + 'static> {
    desired: Selection,
    receiver: Option<oneshot::Receiver<Prepared<D>>>,
}
impl<D: Send + 'static> Drop for Pending<D> {
    fn drop(&mut self) {
        if let Some(receiver) = self.receiver.take() {
            // A completed response can already own a device. Even abandoning
            // that response must not destroy it on the async media executor.
            tokio::task::spawn_blocking(move || drop(receiver));
        }
    }
}

pub(super) struct Runtime<D: OutputDevice = NativeOutput> {
    resource: Option<Resource<D>>,
    pending: Option<Pending<D>>,
    applied: Selection,
    desired: Selection,
    settled: bool,
    error: Option<String>,
    slot: Arc<SessionSlot>,
    open: Open<D>,
    monitor: Monitor,
}

impl Runtime<NativeOutput> {
    pub async fn native(
        epoch: u64,
        endpoint: Option<EndpointPair>,
        slot: Arc<SessionSlot>,
        registry: EndpointRegistry,
        local_host: bool,
    ) -> Result<Self, String> {
        Self::prepare(
            epoch,
            endpoint,
            slot,
            Arc::new(move |pair| {
                if !local_host {
                    return Err(
                        "native audio target requires a loopback render host on this node".into(),
                    );
                }
                let reservation = registry.reserve(pair)?;
                let device = AudioTarget::open(pair).map_err(|e| e.to_string())?;
                Ok(NativeOutput {
                    device,
                    _reservation: reservation,
                })
            }),
        )
        .await
    }
}

impl<D: OutputDevice> Runtime<D> {
    async fn prepare(
        epoch: u64,
        endpoint: Option<EndpointPair>,
        slot: Arc<SessionSlot>,
        open: Open<D>,
    ) -> Result<Self, String> {
        let selection = Selection {
            epoch,
            endpoint: endpoint.clone(),
        };
        let mut runtime = Self {
            resource: None,
            pending: None,
            applied: selection.clone(),
            desired: selection.clone(),
            settled: endpoint.is_none(),
            error: None,
            slot,
            open,
            monitor: Monitor::default(),
        };
        if endpoint.is_some() {
            // Waiting for a previous cancelled cleanup is local to this slot.
            let lifetime = Lifetime {
                _permit: runtime.slot.native.clone().lock_owned().await,
                _slot: runtime.slot.clone(),
            };
            runtime.begin(selection, lifetime);
            let mut pending = runtime.pending.take().expect("initial device operation");
            let prepared = pending
                .receiver
                .as_mut()
                .expect("device response")
                .await
                .map_err(|_| "audio device operation failed".to_string())??;
            runtime.resource = prepared;
            runtime.applied = pending.desired.clone();
            runtime.settled = true;
            runtime.publish();
        }
        Ok(runtime)
    }

    pub fn monitor(&self) -> Monitor {
        self.monitor.clone()
    }

    /// Latest desired state wins. No native call, wait or queue of operations.
    pub fn reconcile(&mut self, epoch: u64, endpoint: Option<EndpointPair>) {
        let desired = Selection { epoch, endpoint };
        if self.desired != desired {
            self.clear();
            self.desired = desired;
            self.settled = false;
            self.error = None;
            self.monitor.set(Snapshot {
                epoch,
                pending: true,
                ..Default::default()
            });
        }
        if let Some(pending) = self.pending.as_mut() {
            match pending
                .receiver
                .as_mut()
                .expect("device response")
                .try_recv()
            {
                Ok(prepared) => {
                    let applied = pending.desired.clone();
                    self.pending = None;
                    match prepared {
                        Ok(resource) => {
                            self.resource = resource;
                            self.applied = applied.clone();
                        }
                        Err(error) => {
                            // A failed obsolete selection must not poison its successor.
                            if applied == self.desired {
                                self.settled = true;
                                self.error = Some(error);
                                self.publish();
                                return;
                            }
                        }
                    }
                    self.settled = applied == self.desired;
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    return;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    let current = pending.desired == self.desired;
                    self.pending = None;
                    if current {
                        self.settled = true;
                        self.error = Some("audio device operation failed".into());
                        self.publish();
                        return;
                    }
                }
            }
        }
        if self.settled {
            self.publish();
            return;
        }
        let lifetime = if let Some(resource) = self.resource.take() {
            resource.device.clear();
            // Keep resource destruction in the same blocking job as opening
            // its successor. The guard remains held across both operations.
            self.begin_replace(self.desired.clone(), Some(resource));
            return;
        } else {
            let Ok(permit) = self.slot.native.clone().try_lock_owned() else {
                self.monitor.set(Snapshot {
                    epoch: self.desired.epoch,
                    pending: true,
                    ..Default::default()
                });
                return;
            };
            Lifetime {
                _permit: permit,
                _slot: self.slot.clone(),
            }
        };
        self.begin(self.desired.clone(), lifetime);
    }

    fn begin(&mut self, desired: Selection, lifetime: Lifetime) {
        self.spawn(desired, None, Some(lifetime));
    }

    fn begin_replace(&mut self, desired: Selection, resource: Option<Resource<D>>) {
        self.spawn(desired, resource, None);
    }

    fn spawn(&mut self, desired: Selection, old: Option<Resource<D>>, lifetime: Option<Lifetime>) {
        let (sender, receiver) = oneshot::channel();
        self.pending = Some(Pending {
            desired: desired.clone(),
            receiver: Some(receiver),
        });
        self.monitor.set(Snapshot {
            epoch: self.desired.epoch,
            pending: true,
            ..Default::default()
        });
        let open = self.open.clone();
        tokio::task::spawn_blocking(move || {
            let lifetime = match old {
                Some(old) => {
                    drop(old.device);
                    old.lifetime
                }
                None => lifetime.expect("device lifetime"),
            };
            let result = match desired.endpoint {
                Some(endpoint) => open(&endpoint).map(|device| Some(Resource { device, lifetime })),
                None => {
                    drop(lifetime);
                    Ok(None)
                }
            };
            // A cancelled receiver destroys a successfully opened device here,
            // on the blocking worker, before releasing its lifetime guard.
            let _ = sender.send(result);
        });
    }

    pub fn clear(&self) {
        if let Some(resource) = &self.resource {
            resource.device.clear();
        }
    }
    pub fn submit(&self, samples: &[f32], captured: Instant) {
        if self.settled
            && self.applied == self.desired
            && let Some(resource) = &self.resource
        {
            resource.device.submit(samples, captured);
        }
    }
    fn publish(&self) {
        self.monitor.set(Snapshot {
            epoch: self.desired.epoch,
            pending: false,
            device: self.resource.as_ref().map(|r| r.device.status()),
            error: self.error.clone(),
        });
    }
}

impl<D: OutputDevice> Drop for Runtime<D> {
    fn drop(&mut self) {
        self.clear();
        self.pending.take();
        self.monitor.set(Snapshot::default());
        if let Some(resource) = self.resource.take() {
            tokio::task::spawn_blocking(move || drop(resource));
        }
    }
}
