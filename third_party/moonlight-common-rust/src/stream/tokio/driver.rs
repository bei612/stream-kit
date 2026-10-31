use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use pin_project_lite::pin_project;
use sans_io_time::Instant as SansInstant;
use tokio::{
    io::ReadBuf,
    net::UdpSocket,
    time::{Instant, Sleep, sleep_until},
};

use crate::{
    error::Error,
    stream::{
        proto::runtime::{Receive, Transmit, UdpStream},
        sockets::new_udp_socket,
    },
};

pub struct StreamDriver<Stream> {
    pub(crate) base_time: Instant,
    pub(crate) inner: Stream,
    pub(crate) socket: UdpSocket,
    pub(crate) transmit: Option<Transmit>,
    pub(crate) transmit_deadline: Option<Instant>,
    pub(crate) recv_buffer: Vec<u8>,
}

impl<Stream> StreamDriver<Stream>
where
    Stream: UdpStream,
{
    pub async fn new(base_time: Instant, stream: Stream) -> Result<Self, Error> {
        let socket = new_udp_socket(false, stream.recv_buffer_hint())?;

        socket.set_nonblocking(true)?;
        let socket = UdpSocket::from_std(socket)?;

        Ok(Self {
            base_time,
            inner: stream,
            socket,
            transmit: None,
            transmit_deadline: None,
            recv_buffer: vec![0; 4096],
        })
    }

    pub fn drive(&mut self) -> DriveFuture<'_, Stream> {
        let deadline = self
            .inner
            .poll_timeout()
            .map(|x| x.to_std(self.base_time.into_std()).into())
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(1));

        DriveFuture {
            driver: self,
            old_deadline: deadline,
            sleep: sleep_until(deadline),
        }
    }

    pub fn stream(&self) -> &Stream {
        &self.inner
    }
    pub fn stream_mut(&mut self) -> &mut Stream {
        &mut self.inner
    }
}

pin_project! {
    pub struct DriveFuture<'a, Stream> {
        driver: &'a mut StreamDriver<Stream>,
        old_deadline: Instant,
        #[pin]
        sleep: Sleep,
    }
}

impl<'a, Stream> Future for DriveFuture<'a, Stream>
where
    Stream: UdpStream,
{
    type Output = Result<Stream::Event, Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();

        loop {
            // -- Write
            if let Some(deadline) = this.driver.transmit_deadline {
                if Instant::now() >= deadline {
                    this.driver.transmit = None;
                    this.driver.transmit_deadline = None;
                }
            }
            // Try to get next packet and write
            if this.driver.transmit.is_none()
                && let Some(new_transmit) = this.driver.inner.poll_transmit()
            {
                this.driver.transmit = Some(new_transmit);
                this.driver.transmit_deadline = this
                    .driver
                    .inner
                    .transmit_max_hold()
                    .map(|hold| Instant::now() + hold);
            }

            if this
                .driver
                .transmit_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                this.driver.transmit = None;
                this.driver.transmit_deadline = None;
                continue;
            }

            // Try to write the available packet
            #[allow(clippy::collapsible_if)]
            if let Some(transmit) = this.driver.transmit.as_mut() {
                if this.driver.socket.poll_send_ready(cx).is_ready() {
                    loop {
                        // Try to write
                        match this
                            .driver
                            .socket
                            .try_send_to(&transmit.data, transmit.destination)
                        {
                            Ok(_) => {
                                // fallthrough
                            }
                            Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock) => {
                                // We cannot send anymore
                                break;
                            }
                            Err(err) => return Poll::Ready(Err(err.into())),
                        }

                        if let Some(new_transmit) = this.driver.inner.poll_transmit() {
                            // Try to get next packet and write
                            *transmit = new_transmit;
                            this.driver.transmit_deadline = this
                                .driver
                                .inner
                                .transmit_max_hold()
                                .map(|hold| Instant::now() + hold);
                            if this
                                .driver
                                .transmit_deadline
                                .is_some_and(|deadline| Instant::now() >= deadline)
                            {
                                break;
                            }
                        } else {
                            // No next packet, remove it
                            this.driver.transmit.take();
                            this.driver.transmit_deadline = None;
                            break;
                        }
                    }
                }
            }

            // Deliver queued events before another receive or timeout can fail
            if let Some(event) = this.driver.inner.poll_event() {
                return Poll::Ready(Ok(event));
            }

            // -- Read
            let mut recv_buffer = ReadBuf::new(&mut this.driver.recv_buffer);
            match this.driver.socket.poll_recv_from(cx, &mut recv_buffer) {
                Poll::Ready(Ok(addr)) => {
                    this.driver.inner.handle_receive(
                        SansInstant::from_std(this.driver.base_time.into_std()),
                        Receive {
                            source: addr,
                            data: recv_buffer.filled(),
                        },
                    )?;
                    // Flush any response and deliver events before reading again.
                    continue;
                }
                Poll::Ready(Err(err)) => return Poll::Ready(Err(err.into())),
                Poll::Pending => {}
            }

            // -- Timeout
            let deadline = this
                .driver
                .inner
                .poll_timeout()
                .map(|x| x.to_std(this.driver.base_time.into_std()).into());

            if let Some(deadline) = deadline {
                // Set new timeout if needed
                if *this.old_deadline != deadline {
                    *this.old_deadline = deadline;
                    this.sleep.as_mut().reset(deadline);
                }

                // Poll Timeout
                if this.sleep.as_mut().poll(cx).is_ready() {
                    this.driver
                        .inner
                        .handle_timeout(SansInstant::from_std(this.driver.base_time.into_std()))?;

                    continue;
                }
            }

            break;
        }

        if let Some(event) = this.driver.inner.poll_event() {
            return Poll::Ready(Ok(event));
        }

        Poll::Pending
    }
}

#[cfg(test)]
mod transmit_tests {
    use super::*;
    use bytes::Bytes;

    struct TestStream(Option<Duration>);
    impl UdpStream for TestStream {
        type Event = ();
        fn poll_transmit(&mut self) -> Option<Transmit> {
            None
        }
        fn transmit_max_hold(&self) -> Option<Duration> {
            self.0
        }
        fn poll_timeout(&self) -> Option<SansInstant> {
            None
        }
        fn poll_event(&mut self) -> Option<()> {
            None
        }
        fn handle_receive(&mut self, _: SansInstant, _: Receive) -> Result<(), Error> {
            Ok(())
        }
        fn handle_timeout(&mut self, _: SansInstant) -> Result<(), Error> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn socket_backpressure_discards_only_expired_datagrams() {
        let receiver = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let destination = receiver.local_addr().unwrap();
        for (limit, age, expected) in [
            (
                Some(Duration::from_millis(60)),
                Duration::from_millis(61),
                false,
            ),
            (Some(Duration::from_millis(60)), Duration::ZERO, true),
            (None, Duration::from_millis(61), true),
        ] {
            let mut driver = StreamDriver::new(Instant::now(), TestStream(limit))
                .await
                .unwrap();
            driver.transmit = Some(Transmit {
                destination,
                data: Bytes::from_static(b"audio"),
            });
            driver.transmit_deadline = limit.map(|hold| Instant::now() + hold.saturating_sub(age));
            let _ = tokio::time::timeout(Duration::from_millis(10), driver.drive()).await;
            let mut buffer = [0u8; 16];
            let received =
                tokio::time::timeout(Duration::from_millis(30), receiver.recv(&mut buffer)).await;
            assert_eq!(received.is_ok(), expected);
        }
    }
}
