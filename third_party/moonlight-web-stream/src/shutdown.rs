//! Register before starting native resources. Windows service workers stop a
//! specific child process group with Ctrl+Break; Actix's default Ctrl+C-only
//! listener does not cover that lifecycle.
use std::{future::Future, io};

pub fn signal() -> io::Result<impl Future<Output = ()> + Send + 'static> {
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let mut interrupt = windows::ctrl_c()?;
        let mut stop = windows::ctrl_break()?;
        let mut close = windows::ctrl_close()?;
        let mut shutdown = windows::ctrl_shutdown()?;
        Ok(async move {
            tokio::select! {
                _ = interrupt.recv() => {},
                _ = stop.recv() => {},
                _ = close.recv() => {},
                _ = shutdown.recv() => {},
            }
        })
    }
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut interrupt = signal(SignalKind::interrupt())?;
        let mut terminate = signal(SignalKind::terminate())?;
        let mut quit = signal(SignalKind::quit())?;
        Ok(async move {
            tokio::select! {
                _ = interrupt.recv() => {},
                _ = terminate.recv() => {},
                _ = quit.recv() => {},
            }
        })
    }
}
