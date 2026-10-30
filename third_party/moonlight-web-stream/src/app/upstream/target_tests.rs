use super::*;
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

type Log = Arc<Mutex<Vec<String>>>;
struct Fake {
    name: String,
    log: Log,
    async_thread: std::thread::ThreadId,
}
impl Drop for Fake {
    fn drop(&mut self) {
        assert_ne!(
            std::thread::current().id(),
            self.async_thread,
            "native destruction ran on media executor"
        );
        self.log
            .lock()
            .expect("log")
            .push(format!("drop:{}", self.name));
    }
}
impl OutputDevice for Fake {
    fn clear(&self) {
        self.log
            .lock()
            .expect("log")
            .push(format!("clear:{}", self.name));
    }
    fn submit(&self, _: &[f32]) {
        self.log
            .lock()
            .expect("log")
            .push(format!("submit:{}", self.name));
    }
    fn status(&self) -> TargetStatus {
        TargetStatus {
            device_open: true,
            device_sample_frames: 0,
            dropped_frames: 0,
            xruns: 0,
            realtime_denied: false,
            error: None,
        }
    }
}
fn pair(name: &str) -> EndpointPair {
    EndpointPair {
        render_device_id: name.into(),
        capture_device_id: format!("{name}-capture"),
    }
}

async fn settle(runtime: &mut Runtime<Fake>, epoch: u64, endpoint: Option<EndpointPair>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            runtime.reconcile(epoch, endpoint.clone());
            let snapshot = runtime.monitor().snapshot();
            if snapshot.epoch == epoch && !snapshot.pending {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("device operation must settle");
}
async fn released(slot: std::sync::Weak<SessionSlot>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while slot.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("native cleanup must release session index");
}

#[tokio::test]
async fn replacement_coalesces_and_never_feeds_obsolete_or_pending_devices() {
    let log = Log::default();
    let events = log.clone();
    let async_thread = std::thread::current().id();
    let (entered, entered_rx) = oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(wait);
    let open: Open<Fake> = Arc::new(move |p| {
        events
            .lock()
            .expect("log")
            .push(format!("open:{}", p.render_device_id));
        if p.render_device_id == "b" {
            entered
                .lock()
                .expect("signal")
                .take()
                .expect("one open")
                .send(())
                .expect("entered");
            wait.lock()
                .expect("gate")
                .recv_timeout(Duration::from_secs(2))
                .expect("release open");
        }
        Ok(Fake {
            name: p.render_device_id.clone(),
            log: events.clone(),
            async_thread,
        })
    });
    let slot = Arc::new(SessionSlot::default());
    let weak = Arc::downgrade(&slot);
    let mut runtime = Runtime::prepare(1, Some(pair("a")), slot.clone(), open)
        .await
        .expect("initial device");
    let monitor = runtime.monitor();
    runtime.reconcile(2, Some(pair("b")));
    entered_rx.await.expect("replacement started");
    runtime.submit(&[1.0]);
    runtime.reconcile(3, Some(pair("c")));
    runtime.submit(&[1.0]);
    release.send(()).expect("release");
    settle(&mut runtime, 3, Some(pair("c"))).await;
    runtime.submit(&[1.0]);
    let first = log.lock().expect("log").clone();
    assert!(!first.iter().any(|e| e == "submit:a" || e == "submit:b"));
    assert!(first.iter().any(|e| e == "submit:c"));
    let index = |s: &str| first.iter().position(|e| e == s).expect("lifecycle event");
    assert!(index("drop:a") < index("open:b"));
    assert!(index("drop:b") < index("open:c"));
    // Same endpoints, new epoch: explicit recovery must reopen the resource.
    settle(&mut runtime, 4, Some(pair("c"))).await;
    assert_eq!(
        log.lock()
            .expect("log")
            .iter()
            .filter(|e| *e == "open:c")
            .count(),
        2
    );
    settle(&mut runtime, 5, None).await;
    assert!(monitor.snapshot().device.is_none());
    drop(runtime);
    drop(slot);
    released(weak).await;
    assert!(
        monitor.snapshot().device.is_none(),
        "telemetry retained native resource"
    );
}

#[tokio::test]
async fn failed_selection_stays_failed_until_explicit_retry() {
    let log = Log::default();
    let attempts = Arc::new(AtomicUsize::new(0));
    let fail = Arc::new(AtomicBool::new(true));
    let (calls, failing, events) = (attempts.clone(), fail.clone(), log.clone());
    let async_thread = std::thread::current().id();
    let open: Open<Fake> = Arc::new(move |p| {
        calls.fetch_add(1, Ordering::SeqCst);
        if failing.load(Ordering::SeqCst) {
            return Err("device unavailable".into());
        }
        Ok(Fake {
            name: p.render_device_id.clone(),
            log: events.clone(),
            async_thread,
        })
    });
    let slot = Arc::new(SessionSlot::default());
    let weak = Arc::downgrade(&slot);
    let mut runtime = Runtime::prepare(1, None, slot.clone(), open)
        .await
        .expect("idle");
    settle(&mut runtime, 2, Some(pair("device"))).await;
    for _ in 0..10 {
        runtime.reconcile(2, Some(pair("device")));
        runtime.submit(&[1.0]);
    }
    assert_eq!(
        runtime.monitor().snapshot().error.as_deref(),
        Some("device unavailable")
    );
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        1,
        "failed configuration retried without a new generation"
    );
    fail.store(false, Ordering::SeqCst);
    settle(&mut runtime, 3, Some(pair("device"))).await;
    assert!(
        runtime
            .monitor()
            .snapshot()
            .device
            .expect("recovered")
            .device_open
    );
    assert!(runtime.monitor().snapshot().error.is_none());
    drop(runtime);
    drop(slot);
    released(weak).await;
}

#[tokio::test]
async fn cancelled_initial_open_retains_native_exclusion_and_index_through_destruction() {
    let log = Log::default();
    let events = log.clone();
    let async_thread = std::thread::current().id();
    let (entered, entered_rx) = oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(wait);
    let slot = Arc::new(SessionSlot::default());
    let weak = Arc::downgrade(&slot);
    let opening_slot = slot.clone();
    let waiter = tokio::spawn(Runtime::prepare(
        1,
        Some(pair("opening")),
        opening_slot,
        Arc::new(move |p| {
            entered
                .lock()
                .expect("signal")
                .take()
                .expect("once")
                .send(())
                .expect("entered");
            wait.lock()
                .expect("gate")
                .recv_timeout(Duration::from_secs(2))
                .expect("release");
            Ok(Fake {
                name: p.render_device_id.clone(),
                log: events.clone(),
                async_thread,
            })
        }),
    ));
    entered_rx.await.expect("open entered");
    waiter.abort();
    assert!(waiter.await.is_err());
    assert!(
        slot.native.try_lock().is_err(),
        "cancelled open released native exclusion early"
    );
    drop(slot);
    assert!(
        weak.upgrade().is_some(),
        "cancelled open lost index lifetime"
    );
    release.send(()).expect("release");
    released(weak).await;
    assert!(log.lock().expect("log").iter().any(|e| e == "drop:opening"));
}

#[tokio::test]
async fn dropping_completed_unconsumed_open_destroys_device_off_executor() {
    let log = Log::default();
    let events = log.clone();
    let async_thread = std::thread::current().id();
    let slot = Arc::new(SessionSlot::default());
    let weak = Arc::downgrade(&slot);
    let mut runtime = Runtime::prepare(
        1,
        None,
        slot.clone(),
        Arc::new(move |p| {
            Ok(Fake {
                name: p.render_device_id.clone(),
                log: events.clone(),
                async_thread,
            })
        }),
    )
    .await
    .expect("idle");
    runtime.reconcile(2, Some(pair("queued")));
    // Peek without consuming the result: Pending's cancellation path owns it.
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime
            .pending
            .as_mut()
            .expect("pending")
            .receiver
            .as_mut()
            .expect("receiver")
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("open completed");
    drop(runtime);
    drop(slot);
    released(weak).await;
    assert!(log.lock().expect("log").iter().any(|e| e == "drop:queued"));
}

#[test]
fn endpoint_reservations_are_atomic_across_sessions_and_directions() {
    let registry = EndpointRegistry::default();
    let a = registry.reserve(&pair("a")).expect("first owner");
    assert!(registry.reserve(&pair("a")).is_err());
    assert!(
        registry
            .reserve(&EndpointPair {
                render_device_id: "a-capture".into(),
                capture_device_id: "different".into()
            })
            .is_err()
    );
    let unrelated = registry.reserve(&pair("b")).expect("independent owner");
    drop(a);
    assert!(registry.reserve(&pair("a")).is_ok());
    drop(unrelated);
    assert!(registry.0.lock().expect("registry").is_empty());
}
