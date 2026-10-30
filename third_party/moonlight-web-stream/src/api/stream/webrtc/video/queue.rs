//! Per-viewer bounded delivery. A dropped frame invalidates dependent frames.
use tokio::sync::mpsc::{self, Receiver, Sender, error::TrySendError};

pub(super) struct FrameQueue<T> {
    sender: Sender<T>,
    waiting_for_idr: bool,
    request_idr: bool,
}

impl<T> FrameQueue<T> {
    pub fn new() -> (Self, Receiver<T>) {
        let (sender, receiver) = mpsc::channel(3);
        (
            Self {
                sender,
                waiting_for_idr: false,
                request_idr: false,
            },
            receiver,
        )
    }

    pub fn waiting_for_idr(&self) -> bool {
        self.waiting_for_idr
    }
    pub fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }
    pub fn take_idr_request(&mut self) -> bool {
        std::mem::take(&mut self.request_idr)
    }

    pub fn push(&mut self, frame: T, is_idr: bool) {
        if self.waiting_for_idr && !is_idr {
            return;
        }
        match self.sender.try_send(frame) {
            Ok(()) => self.waiting_for_idr = false,
            Err(TrySendError::Full(_)) => {
                self.waiting_for_idr = true;
                self.request_idr = true;
            }
            Err(TrySendError::Closed(_)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_requires_keyframe_before_accepting_dependent_frames() {
        let (mut queue, mut receiver) = FrameQueue::new();
        for frame in 1..=3 {
            queue.push(frame, false);
        }
        queue.push(4, false);
        assert!(queue.take_idr_request());
        assert!(!queue.take_idr_request());
        assert!(queue.waiting_for_idr());
        assert_eq!(receiver.try_recv(), Ok(1));
        queue.push(5, false);
        assert_eq!(
            receiver.len(),
            2,
            "dependent frame cannot bridge a dropped frame"
        );
        queue.push(6, true);
        assert!(!queue.waiting_for_idr());
        assert_eq!(receiver.try_recv(), Ok(2));
        assert_eq!(receiver.try_recv(), Ok(3));
        assert_eq!(receiver.try_recv(), Ok(6));
        queue.push(7, false);
        assert_eq!(receiver.try_recv(), Ok(7));
    }

    #[test]
    fn rejected_keyframe_requests_another_without_growing_queue() {
        let (mut queue, mut receiver) = FrameQueue::new();
        for frame in 0..100 {
            queue.push(frame, false);
        }
        assert_eq!(receiver.len(), 3);
        assert!(queue.take_idr_request());
        queue.push(100, true);
        assert!(queue.take_idr_request());
        assert!(queue.waiting_for_idr());
        assert_eq!(receiver.len(), 3);
        receiver.close();
        assert!(queue.is_closed());
    }
}
