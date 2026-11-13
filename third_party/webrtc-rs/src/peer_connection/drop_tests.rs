use super::*;
use std::net::UdpSocket;

struct Events;
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Events {}

#[tokio::test]
async fn dropping_unnegotiated_peer_releases_real_udp_socket() {
    for pool_size in [0, 1] {
        for _ in 0..12 {
            let reservation = UdpSocket::bind("127.0.0.1:0").expect("reserve UDP port");
            let address = reservation.local_addr().expect("reserved address");
            drop(reservation);
            let peer = PeerConnectionBuilder::default()
                .with_handler(Arc::new(Events))
                .with_udp_addrs(vec![address])
                .with_dedicated_reactor_pool_size(pool_size)
                .with_setting_engine(
                    SettingEngineBuilder::new()
                        .with_multicast_dns_mode(rtc::ice::mdns::MulticastDnsMode::Disabled)
                        .build(),
                )
                .build()
                .await
                .expect("real native peer");
            let channel = peer
                .create_data_channel("lifetime-check", None)
                .await
                .expect("real channel");
            assert!(UdpSocket::bind(address).is_err(), "peer did not own socket");
            // Failed/cancelled SDP setup may drop the peer before close() runs.
            // Even a remaining channel handle must not pin its native driver.
            drop(peer);
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(socket) = UdpSocket::bind(address) {
                        drop(socket);
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("dropped peer retained socket/driver resources");
            drop(channel);
        }
    }
}
