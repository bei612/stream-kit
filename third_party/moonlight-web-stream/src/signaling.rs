use std::{
    any::Any,
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use actix_tls::accept::rustls_0_23::TlsStream;
use actix_web::{dev::Extensions, rt::net::TcpStream};

pub(crate) struct LocalAddress(SocketAddr);

pub(crate) fn record_local_address(transport: &dyn Any, extensions: &mut Extensions) {
    let socket = transport.downcast_ref::<TcpStream>().or_else(|| {
        transport
            .downcast_ref::<TlsStream<TcpStream>>()
            .map(|tls| tls.get_ref().0)
    });
    if let Some(address) = socket.and_then(|socket| socket.local_addr().ok()) {
        extensions.insert(LocalAddress(address));
    }
}

impl LocalAddress {
    pub(crate) fn media_bind_address(ingress: Option<&Self>) -> SocketAddr {
        let ipv4 = ingress.and_then(|ingress| match ingress.0.ip() {
            IpAddr::V4(ip) => Some(ip),
            IpAddr::V6(ip) => ip.to_ipv4_mapped(),
        });
        // The gateway currently offers UDP/IPv4. Keep the existing discovery
        // path for local reverse proxies and non-IPv4 signaling connections.
        let bind_ip = ipv4
            .filter(|ip| {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_link_local()
                    && !ip.is_multicast()
                    && !ip.is_broadcast()
            })
            .unwrap_or(Ipv4Addr::UNSPECIFIED);
        SocketAddr::from((bind_ip, 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_connections_bind_to_the_current_signaling_address() {
        for (incoming, expected) in [
            ("192.168.0.119:8080", "192.168.0.119:0"),
            ("[::ffff:192.168.2.131]:8080", "192.168.2.131:0"),
        ] {
            let incoming = LocalAddress(incoming.parse().expect("test signaling socket"));
            assert_eq!(
                LocalAddress::media_bind_address(Some(&incoming)),
                expected
                    .parse::<SocketAddr>()
                    .expect("test media bind socket"),
            );
        }
    }

    #[test]
    fn non_direct_paths_keep_the_existing_udp_discovery() {
        let wildcard = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0));
        assert_eq!(LocalAddress::media_bind_address(None), wildcard);
        for incoming in ["127.0.0.1:8080", "[::1]:8080", "169.254.1.1:8080"] {
            let incoming = LocalAddress(incoming.parse().expect("test fallback socket"));
            assert_eq!(LocalAddress::media_bind_address(Some(&incoming)), wildcard);
        }
    }
}
