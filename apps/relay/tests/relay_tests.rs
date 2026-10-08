//! Relay end-to-end test.
//!
//! Topology, matching production:
//!
//! ```text
//! player --> relay(public) --pair--> relay-side slot <=outbound<= host --> game
//! ```
//!
//! The host dials out to the relay's tunnel port and handshakes. The relay parks
//! its side of that socket; the host wires its side through to the local game
//! server. A player connection is then paired with the parked slot.

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use nomad_relay::{accept_slot, serve_player, Registry};

/// A tiny echo server standing in for the host's Minecraft process.
async fn fake_game_server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    addr
}

#[tokio::test]
async fn player_reaches_the_game_server_through_a_slot() {
    let game = fake_game_server().await;
    let room = "room_test";
    let registry = Registry::new();

    // --- relay side: accept the host's outbound tunnel and park the slot ---
    let relay_tunnel = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tunnel_addr = relay_tunnel.local_addr().unwrap();
    let reg_for_slot = registry.clone();
    tokio::spawn(async move {
        let (incoming, _) = relay_tunnel.accept().await.unwrap();
        let slot = accept_slot(incoming, room).await.unwrap();
        reg_for_slot.park(slot).await;
    });

    // --- host side: dial out, handshake, then wire the socket to the game ---
    let host_side = TcpStream::connect(tunnel_addr).await.unwrap();
    let (hr, mut hw) = host_side.into_split();
    hw.write_all(format!("SLOT {room}\n").as_bytes())
        .await
        .unwrap();
    let mut reader = BufReader::new(hr);
    let mut ack = String::new();
    reader.read_line(&mut ack).await.unwrap();
    assert_eq!(ack.trim(), "OK", "host handshake should be acknowledged");

    // Wire host socket <-> game server, exactly like the agent's local proxy.
    let game_conn = TcpStream::connect(game).await.unwrap();
    let (mut game_r, mut game_w) = game_conn.into_split();
    let (mut host_r, mut host_w) = (reader, hw);
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut host_r, &mut game_w).await;
    });
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut game_r, &mut host_w).await;
    });

    // Wait for the relay to park the slot.
    for _ in 0..100 {
        if registry.available().await > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(registry.available().await, 1, "a slot should be parked");

    // --- player side: connect to the relay's public port and get paired ---
    let relay_public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_addr = relay_public.local_addr().unwrap();
    let reg_for_public = registry.clone();
    tokio::spawn(async move {
        let (player, _) = relay_public.accept().await.unwrap();
        let _ = serve_player(player, reg_for_public).await;
    });

    let mut client = TcpStream::connect(public_addr).await.unwrap();
    client.write_all(b"hello minecraft").await.unwrap();
    let mut buf = vec![0u8; 15];
    tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut buf))
        .await
        .expect("echo should arrive")
        .unwrap();
    assert_eq!(
        &buf, b"hello minecraft",
        "echo must round-trip through the relay"
    );
}

#[tokio::test]
async fn player_with_no_host_gets_a_clear_error() {
    let registry = Registry::new();
    let relay_public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = relay_public.local_addr().unwrap();
    let reg = registry.clone();
    tokio::spawn(async move {
        let (player, _) = relay_public.accept().await.unwrap();
        let _ = serve_player(player, reg).await;
    });
    let mut client = TcpStream::connect(addr).await.unwrap();
    let mut buf = Vec::new();
    client.read_to_end(&mut buf).await.unwrap();
    assert_eq!(&buf, b"NOMAD_NO_HOST\n");
}

#[tokio::test]
async fn slot_for_the_wrong_room_is_rejected() {
    let relay_tunnel = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = relay_tunnel.local_addr().unwrap();
    tokio::spawn(async move {
        let (incoming, _) = relay_tunnel.accept().await.unwrap();
        let _ = accept_slot(incoming, "room_expected").await;
    });
    let mut client = TcpStream::connect(addr).await.unwrap();
    client.write_all(b"SLOT room_wrong\n").await.unwrap();
    let mut buf = Vec::new();
    client.read_to_end(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf).contains("ERR"));
}
