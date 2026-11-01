//! Bounded command delivery with an interruptible audio deadline. Windows uses
//! a per-connection high-resolution timer; no global timer-resolution changes.
use std::{io, sync::mpsc, time::Instant};

pub enum Event<T> {
    Message(T),
    Deadline,
    Closed,
}

pub struct Sender<T> {
    channel: Option<mpsc::SyncSender<T>>,
    #[cfg(windows)]
    wake: std::sync::Arc<native::Wake>,
}

pub struct Receiver<T> {
    channel: mpsc::Receiver<T>,
    #[cfg(windows)]
    wake: std::sync::Arc<native::Wake>,
    #[cfg(windows)]
    timer: native::Timer,
}

pub fn channel<T>(capacity: usize) -> io::Result<(Sender<T>, Receiver<T>)> {
    let (tx, rx) = mpsc::sync_channel(capacity);
    #[cfg(windows)]
    let wake = std::sync::Arc::new(native::Wake::new()?);
    Ok((
        Sender {
            channel: Some(tx),
            #[cfg(windows)]
            wake: wake.clone(),
        },
        Receiver {
            channel: rx,
            #[cfg(windows)]
            wake,
            #[cfg(windows)]
            timer: native::Timer::new()?,
        },
    ))
}

impl<T> Sender<T> {
    pub fn send(&self, value: T) -> io::Result<()> {
        self.channel
            .as_ref()
            .ok_or_else(|| io::Error::other("audio command sender closed"))?
            .send(value)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "audio receiver closed"))?;
        #[cfg(windows)]
        self.wake.signal()?;
        Ok(())
    }
}

impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        // Publish disconnection before waking an idle receiver, including panic
        // unwinding. Otherwise it could consume the wake and sleep forever.
        drop(self.channel.take());
        #[cfg(windows)]
        let _ = self.wake.signal();
    }
}

impl<T> Receiver<T> {
    pub fn receive(&self, deadline: Option<Instant>) -> io::Result<Event<T>> {
        #[cfg(windows)]
        loop {
            // Deadline takes priority even under continuous command traffic.
            if deadline.is_some_and(|due| due <= Instant::now()) {
                return Ok(Event::Deadline);
            }
            match self.channel.try_recv() {
                Ok(value) => return Ok(Event::Message(value)),
                Err(mpsc::TryRecvError::Disconnected) => return Ok(Event::Closed),
                Err(mpsc::TryRecvError::Empty) => self.timer.wait(&self.wake, deadline)?,
            }
        }
        #[cfg(not(windows))]
        {
            use mpsc::RecvTimeoutError;
            Ok(match deadline {
                Some(due) => {
                    if due <= Instant::now() {
                        return Ok(Event::Deadline);
                    }
                    match self
                        .channel
                        .recv_timeout(due.saturating_duration_since(Instant::now()))
                    {
                        Ok(value) => Event::Message(value),
                        Err(RecvTimeoutError::Timeout) => Event::Deadline,
                        Err(RecvTimeoutError::Disconnected) => Event::Closed,
                    }
                }
                None => match self.channel.recv() {
                    Ok(value) => Event::Message(value),
                    Err(_) => Event::Closed,
                },
            })
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateEventW(
            security: *const c_void,
            manual: i32,
            initial: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn SetEvent(event: *mut c_void) -> i32;
        fn CreateWaitableTimerExW(
            security: *const c_void,
            name: *const u16,
            flags: u32,
            access: u32,
        ) -> *mut c_void;
        fn SetWaitableTimerEx(
            timer: *mut c_void,
            due: *const i64,
            period: i32,
            callback: *const c_void,
            argument: *const c_void,
            context: *const c_void,
            tolerance: u32,
        ) -> i32;
        fn WaitForMultipleObjects(
            count: u32,
            handles: *const *mut c_void,
            all: i32,
            timeout: u32,
        ) -> u32;
    }

    fn owned(handle: *mut c_void) -> io::Result<OwnedHandle> {
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful creation transfers sole ownership of this handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    pub struct Wake(OwnedHandle);
    impl Wake {
        pub fn new() -> io::Result<Self> {
            // SAFETY: unnamed, non-inheritable, auto-reset event; no retained pointers.
            owned(unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) }).map(Self)
        }
        pub fn signal(&self) -> io::Result<()> {
            // SAFETY: the Arc keeps the event alive across send and wait.
            if unsafe { SetEvent(self.0.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
    pub struct Timer(OwnedHandle);
    impl Timer {
        pub fn new() -> io::Result<Self> {
            // HIGH_RESOLUTION, SYNCHRONIZE | TIMER_MODIFY_STATE, Windows 10 1803+.
            // https://learn.microsoft.com/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw
            // SAFETY: unnamed, non-inheritable handle, no retained pointers.
            owned(unsafe { CreateWaitableTimerExW(ptr::null(), ptr::null(), 2, 0x0010_0002) })
                .map(Self)
        }
        pub fn wait(&self, wake: &Wake, deadline: Option<Instant>) -> io::Result<()> {
            let handles = [wake.0.as_raw_handle(), self.0.as_raw_handle()];
            let count = if let Some(deadline) = deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Ok(());
                }
                let ticks = remaining.as_nanos().div_ceil(100).min(i64::MAX as u128) as i64;
                let due = -ticks;
                // SAFETY: valid owned timer and stack due value copied by Windows.
                // One shot, no APC, no wake-from-sleep, no coalescing tolerance.
                if unsafe {
                    SetWaitableTimerEx(
                        self.0.as_raw_handle(),
                        &due,
                        0,
                        ptr::null(),
                        ptr::null(),
                        ptr::null(),
                        0,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                2
            } else {
                1
            };
            // SAFETY: both handles remain alive throughout this non-alertable wait.
            let status = unsafe { WaitForMultipleObjects(count, handles.as_ptr(), 0, u32::MAX) };
            if status < count {
                Ok(())
            } else if status == u32::MAX {
                Err(io::Error::last_os_error())
            } else {
                Err(io::Error::other(format!(
                    "unexpected audio wait status {status:#x}"
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn messages_interrupt_deadlines_and_disconnect_wakes_idle_receiver() -> io::Result<()> {
        let (tx, rx) = channel(2)?;
        let task = thread::spawn(move || -> io::Result<()> {
            thread::sleep(Duration::from_millis(10));
            tx.send(41)?;
            tx.send(42)?;
            thread::sleep(Duration::from_millis(10));
            Ok(()) // Drop disconnects and wakes even with no deadline.
        });
        assert!(matches!(
            rx.receive(Some(Instant::now() + Duration::from_secs(2)))?,
            Event::Message(41)
        ));
        assert!(matches!(rx.receive(None)?, Event::Message(42)));
        assert!(matches!(rx.receive(None)?, Event::Closed));
        task.join()
            .map_err(|_| io::Error::other("sender panicked"))??;
        Ok(())
    }

    #[test]
    fn due_clock_is_not_starved_by_messages() -> io::Result<()> {
        let (tx, rx) = channel(2)?;
        tx.send(1)?;
        let deadline = Instant::now();
        assert!(matches!(rx.receive(Some(deadline))?, Event::Deadline));
        assert!(matches!(rx.receive(None)?, Event::Message(1)));
        let deadline = Instant::now() + Duration::from_millis(2);
        assert!(matches!(rx.receive(Some(deadline))?, Event::Deadline));
        assert!(Instant::now() >= deadline);
        Ok(())
    }

    #[test]
    fn closing_receiver_releases_blocked_sender() -> io::Result<()> {
        let (tx, rx) = channel(1)?;
        tx.send(1)?;
        let task = thread::spawn(move || tx.send(2));
        drop(rx);
        assert!(
            task.join()
                .map_err(|_| io::Error::other("sender panicked"))?
                .is_err()
        );
        Ok(())
    }
}
