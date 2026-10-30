//! Atomic port selection: the returned bound socket remains owned by the driver.
use std::{
    io,
    net::{SocketAddr, UdpSocket},
};

pub(super) fn bind_udp_in_range(
    mut address: SocketAddr,
    range: Option<(u16, u16)>,
) -> io::Result<UdpSocket> {
    let Some((min, max)) = range.filter(|_| address.port() == 0) else {
        return UdpSocket::bind(address);
    };
    if min == 0 || min > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid UDP port range",
        ));
    }
    let mut last = io::Error::new(io::ErrorKind::AddrInUse, "UDP port range exhausted");
    for port in min..=max {
        address.set_port(port);
        match UdpSocket::bind(address) {
            Ok(socket) => return Ok(socket),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
                ) =>
            {
                last = error
            }
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn occupied_port_stays_owned_until_release() -> io::Result<()> {
        let socket = UdpSocket::bind("127.0.0.1:0")?;
        let port = socket.local_addr()?.port();
        let address = "127.0.0.1:0".parse().expect("loopback address");
        assert!(bind_udp_in_range(address, Some((port, port))).is_err());
        drop(socket);
        let owned = bind_udp_in_range(address, Some((port, port)))?;
        assert_eq!(owned.local_addr()?.port(), port);
        assert!(bind_udp_in_range(address, Some((port, port))).is_err());
        Ok(())
    }
    #[test]
    fn invalid_range_never_uses_ephemeral_ports() {
        for range in [(0, 0), (100, 99)] {
            assert_eq!(
                bind_udp_in_range("127.0.0.1:0".parse().expect("loopback"), Some(range))
                    .expect_err("invalid range")
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn concurrent_bindings_keep_distinct_owned_ports() -> io::Result<()> {
        let seed = UdpSocket::bind("127.0.0.1:0")?;
        let min = seed.local_addr()?.port().min(65000);
        let max = min + 100;
        let workers: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(move || {
                    bind_udp_in_range("127.0.0.1:0".parse().expect("loopback"), Some((min, max)))
                })
            })
            .collect();
        let sockets: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().expect("binding worker"))
            .collect::<io::Result<_>>()?;
        let mut ports = std::collections::HashSet::new();
        for socket in &sockets {
            let port = socket.local_addr()?.port();
            assert!((min..=max).contains(&port));
            assert!(ports.insert(port), "concurrent sockets share a port");
        }
        Ok(())
    }
}
