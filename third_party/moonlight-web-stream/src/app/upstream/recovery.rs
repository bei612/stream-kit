//! Coalesce viewer recovery requests without consuming input/audio capacity.
use tokio::{
    sync::mpsc,
    time::{Duration, Instant, sleep_until},
};

pub(super) struct Requests(mpsc::Sender<()>);
pub(super) struct Recovery {
    receiver: mpsc::Receiver<()>,
    pending: bool,
    next: Instant,
}

pub(super) fn channel() -> (Requests, Recovery) {
    let (sender, receiver) = mpsc::channel(1);
    (
        Requests(sender),
        Recovery {
            receiver,
            pending: false,
            next: Instant::now(),
        },
    )
}

impl Requests {
    pub fn request(&self) -> bool {
        match self.0.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => true,
            Err(mpsc::error::TrySendError::Closed(())) => false,
        }
    }
}

impl Recovery {
    // Pending state survives cancellation by the shared driver's select loop.
    pub async fn recv(&mut self) -> Option<()> {
        if !self.pending {
            self.receiver.recv().await?;
            self.pending = true;
        }
        sleep_until(self.next).await;
        // Requests arriving during the cooldown are covered by this keyframe.
        let _ = self.receiver.try_recv();
        self.pending = false;
        self.next = Instant::now() + Duration::from_millis(250);
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bursts_coalesce_and_cancelled_wait_preserves_recovery() {
        let (requests, mut recovery) = channel();
        for _ in 0..1000 {
            assert!(requests.request());
        }
        assert_eq!(recovery.receiver.len(), 1);
        assert_eq!(recovery.recv().await, Some(()));
        assert!(requests.request());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), recovery.recv())
                .await
                .is_err()
        );
        assert!(recovery.pending);
        for _ in 0..1000 {
            assert!(requests.request());
        }
        let before = Instant::now();
        assert_eq!(recovery.recv().await, Some(()));
        assert_eq!(Instant::now() - before, Duration::from_millis(150));
        assert!(recovery.receiver.is_empty());
        assert!(
            tokio::time::timeout(Duration::from_secs(1), recovery.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn closure_is_not_reported_as_success() {
        let (requests, recovery) = channel();
        drop(recovery);
        assert!(!requests.request());
        let (requests, mut recovery) = channel();
        drop(requests);
        assert_eq!(recovery.recv().await, None);
    }
}
