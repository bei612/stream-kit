//! One local import connection. Driver attachment, listener ownership and device
//! installation are separate lifecycle responsibilities; this module never
//! creates a persistent service or changes Windows defaults.
use super::{
    engine::Engine,
    export::{DEVICE_ID, Export},
    usbip,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionOutcome {
    NotImported,
    Imported,
}
use std::{
    io::{self, BufWriter, Write},
    net::{Shutdown, TcpStream},
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

/// Serve a connected loopback socket. The owner retains a cloned socket and
/// calls shutdown(Both) to stop it, including while the peer is idle. All reader
/// threads are joined on every exit. Network and pending queues remain bounded.
pub fn serve_connection(stream: TcpStream, export: Export) -> io::Result<ConnectionOutcome> {
    if !stream.peer_addr()?.ip().is_loopback() || !stream.local_addr()?.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "virtual audio accepts loopback connections only",
        ));
    }
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = stream.try_clone()?;
    let mut writer = BufWriter::with_capacity(65536, stream.try_clone()?);
    if !export.handshake(&mut reader, &mut writer)? {
        writer.flush()?;
        return Ok(ConnectionOutcome::NotImported);
    }
    writer.flush()?;
    reader.set_read_timeout(None)?;
    let (sender, receiver) = mpsc::sync_channel(32);
    let read_thread = thread::Builder::new()
        .name("virtual-audio-usb-reader".into())
        .spawn(move || {
            loop {
                let request = usbip::read_request(&mut reader);
                let failed = request.is_err();
                if sender.send(request).is_err() || failed {
                    break;
                }
            }
        })?;
    let mut engine = Engine::new(DEVICE_ID, export.into_class(), Instant::now());
    let result = (|| -> io::Result<()> {
        loop {
            engine.complete_due(Instant::now(), &mut writer)?;
            writer.flush()?;
            let event = if let Some(deadline) = engine.next_deadline() {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(value) => value,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match receiver.recv() {
                    Ok(value) => value,
                    Err(_) => break,
                }
            };
            match event {
                Ok(request) => engine.request(request, Instant::now(), &mut writer)?,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::UnexpectedEof
                            | io::ErrorKind::ConnectionReset
                            | io::ErrorKind::ConnectionAborted
                    ) =>
                {
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })();
    // Shutdown releases a reader blocked in read_exact; dropping the receiver
    // releases one blocked sending into the bounded channel.
    let _ = stream.shutdown(Shutdown::Both);
    drop(receiver);
    let joined = read_thread.join();
    result?;
    joined.map_err(|_| io::Error::other("virtual audio reader terminated unexpectedly"))?;
    Ok(ConnectionOutcome::Imported)
}

#[cfg(test)]
mod tests {
    use super::super::audio_class::{AudioClass, Identity, PACKET_BYTES};
    use super::*;
    use std::{io::Read, net::TcpListener};
    fn header(
        seq: u32,
        direction: u32,
        endpoint: u32,
        length: u32,
        count: i32,
        setup: [u8; 8],
    ) -> Vec<u8> {
        let mut h = Vec::new();
        for value in [
            1,
            seq,
            DEVICE_ID,
            direction,
            endpoint,
            0,
            length,
            0,
            count as u32,
            1,
        ] {
            h.extend(value.to_be_bytes());
        }
        h.extend(setup);
        h
    }
    fn read_reply(peer: &mut TcpStream) -> (u32, i32, Vec<u8>) {
        let mut h = [0; 48];
        peer.read_exact(&mut h).unwrap();
        let word = |offset| u32::from_be_bytes(h[offset..offset + 4].try_into().unwrap());
        let seq = word(4);
        let status = word(20) as i32;
        let count = word(32) as i32;
        // This test uses odd sequence 11 for capture, all other requests are OUT.
        let size = if seq == 11 { word(24) as usize } else { 0 };
        let mut data = vec![0; size];
        peer.read_exact(&mut data).unwrap();
        let mut packets = vec![0; count.max(0) as usize * 16];
        peer.read_exact(&mut packets).unwrap();
        (seq, status, data)
    }
    #[test]
    fn actual_loopback_import_controls_pcm_and_clean_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let class = AudioClass::new(Identity {
                vendor: 0xfffe,
                product: 1,
                serial: "TestOnly".into(),
            })
            .unwrap();
            serve_connection(stream, Export::new("TestBusOnly".into(), class).unwrap())
        });
        let mut peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        peer.set_nodelay(true).unwrap();
        let mut import = vec![1, 0x11, 0x80, 3, 0, 0, 0, 0];
        let mut bus = [0u8; 32];
        bus[..11].copy_from_slice(b"TestBusOnly");
        import.extend(bus);
        peer.write_all(&import).unwrap();
        let mut reply = [0; 320];
        peer.read_exact(&mut reply).unwrap();
        assert_eq!(&reply[..8], &[1, 0x11, 0, 3, 0, 0, 0, 0]);
        for (seq, setup) in [
            (1, [0, 9, 1, 0, 0, 0, 0, 0]),
            (2, [1, 11, 1, 0, 1, 0, 0, 0]),
            (3, [1, 11, 1, 0, 2, 0, 0, 0]),
        ] {
            peer.write_all(&header(seq, 0, 0, 0, -1, setup)).unwrap();
            assert_eq!(read_reply(&mut peer), (seq, 0, Vec::new()));
        }
        let mut out = header(10, 0, 1, PACKET_BYTES as u32, 1, [0; 8]);
        let pcm: Vec<u8> = (0..PACKET_BYTES).map(|n| n as u8).collect();
        out.extend(&pcm);
        for value in [0u32, PACKET_BYTES as u32, 0, 0] {
            out.extend(value.to_be_bytes());
        }
        peer.write_all(&out).unwrap();
        assert_eq!(read_reply(&mut peer), (10, 0, Vec::new()));
        let mut input = header(11, 1, 2, PACKET_BYTES as u32, 1, [0; 8]);
        for value in [0u32, PACKET_BYTES as u32, 0, 0] {
            input.extend(value.to_be_bytes());
        }
        peer.write_all(&input).unwrap();
        assert_eq!(read_reply(&mut peer), (11, 0, pcm));
        peer.shutdown(Shutdown::Both).unwrap();
        server.join().unwrap().unwrap();
    }
}
