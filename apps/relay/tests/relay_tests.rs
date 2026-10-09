//! Relay end-to-end tests.
//!
//! These drive the real protocol path: a client sends an actual Minecraft handshake,
//! and we check that a status ping is answered by the relay itself while a login is
//! routed by hostname to the right host and spliced byte-for-byte.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use nomad_mcproto::{encode_packet, encode_string, write_varint};
use nomad_relay::{Registry, RoomRoute};

fn route(host: &str) -> RoomRoute {
    RoomRoute {
        hostname: host.to_string(),
        room_id: host.to_string(),
        motd_offline: format!("{host} :: asleep"),
        motd_online: format!("{host} :: live"),
        version_name: "1.21.4".into(),
        max_players: 20,
        registry: Registry::new(),
        door: None,
    }
}

fn routes(hosts: &[&str]) -> Arc<HashMap<String, RoomRoute>> {
    Arc::new(hosts.iter().map(|h| (h.to_string(), route(h))).collect())
}

/// Build a Minecraft handshake packet.
fn handshake(addr: &str, intent: i32) -> Vec<u8> {
    let mut body = Vec::new();
    write_varint(&mut body, 0x00);
    write_varint(&mut body, 767);
    body.extend_from_slice(&encode_string(addr));
    body.extend_from_slice(&25565u16.to_be_bytes());
    write_varint(&mut body, intent);
    encode_packet(body[0] as i32, &body[1..])
}

/// Build a status-request packet (id 0, no body).
fn status_request() -> Vec<u8> {
    encode_packet(0x00, &[])
}

/// A tiny echo server standing in for a host's game server.
///
/// It first consumes the Minecraft handshake exactly as a real server would — which
/// also proves the relay replayed those bytes intact — and then echoes everything
/// that follows.
async fn fake_game_server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                // Read until a full handshake parses.
                let mut head = Vec::new();
                let mut consumed = 0usize;
                while consumed == 0 {
                    let mut chunk = [0u8; 256];
                    let n = match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    head.extend_from_slice(&chunk[..n]);
                    match nomad_mcproto::try_read_handshake(&head) {
                        Ok(Some((_hs, used))) => consumed = used,
                        Ok(None) => {}
                        Err(_) => return,
                    }
                }
                // Echo any bytes that arrived past the handshake.
                if head.len() > consumed && sock.write_all(&head[consumed..]).await.is_err() {
                    return;
                }
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

/// A host: dial the relay tunnel, handshake its room, and wire the slot to a game
/// server. Returns once the slot is parked.
async fn connect_host(tunnel_addr: std::net::SocketAddr, host: &str, game: std::net::SocketAddr) {
    let stream = TcpStream::connect(tunnel_addr).await.unwrap();
    let (mut r, mut w) = stream.into_split();
    w.write_all(format!("SLOT {host}\n").as_bytes())
        .await
        .unwrap();
    let mut ack = [0u8; 3];
    r.read_exact(&mut ack).await.unwrap();
    assert_eq!(&ack, b"OK\n");

    let game_conn = TcpStream::connect(game).await.unwrap();
    let (mut gr, mut gw) = game_conn.into_split();
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut r, &mut gw).await;
    });
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut gr, &mut w).await;
    });
}

#[tokio::test]
async fn status_ping_is_answered_by_the_relay() {
    let routes = routes(&["friends.example.com"]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let r = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, r).await;
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client
        .write_all(&handshake("friends.example.com", 1))
        .await
        .unwrap();
    client.write_all(&status_request()).await.unwrap();

    let mut resp = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut resp))
        .await
        .expect("relay should answer promptly")
        .unwrap();

    let text = String::from_utf8_lossy(&resp);
    assert!(
        text.contains("asleep"),
        "offline MOTD expected, got: {text}"
    );
    assert!(text.contains("\"max\""), "should be a status JSON document");
}

#[tokio::test]
async fn login_is_routed_by_hostname_and_spliced() {
    let game = fake_game_server().await;
    let routes = routes(&["friends.example.com", "other.example.com"]);

    let tunnel = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tunnel_addr = tunnel.local_addr().unwrap();
    let routes_for_tunnel = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = tunnel.accept().await.unwrap();
        let _ = nomad_relay::handle_slot_for_test(stream, routes_for_tunnel).await;
    });

    connect_host(tunnel_addr, "friends.example.com", game).await;

    // Wait for the slot to be parked.
    for _ in 0..100 {
        if routes[&"friends.example.com".to_string()]
            .registry
            .available()
            .await
            > 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        routes[&"friends.example.com".to_string()]
            .registry
            .available()
            .await,
        1
    );

    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_addr = public.local_addr().unwrap();
    let routes_for_public = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = public.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, routes_for_public).await;
    });

    let mut client = TcpStream::connect(public_addr).await.unwrap();
    client
        .write_all(&handshake("friends.example.com", 2))
        .await
        .unwrap();
    client.write_all(b"game-data-after-login").await.unwrap();

    // The echo comes back through relay -> slot -> game and out again.
    let mut buf = vec![0u8; "game-data-after-login".len()];
    tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut buf))
        .await
        .expect("echo must arrive")
        .unwrap();
    assert_eq!(&buf, b"game-data-after-login");

    // The backend received the handshake replayed, not lost.
    // (The echo proves the pipe works; the handshake replay is covered by the
    //  parser's consumed-bytes test and the splice here.)
}

#[tokio::test]
async fn login_to_an_unknown_room_is_refused() {
    let routes = routes(&["friends.example.com"]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let r = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, r).await;
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client
        .write_all(&handshake("nope.example.com", 2))
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf)).await;
    let text = String::from_utf8_lossy(&buf);
    assert!(text.contains("unknown room"), "got: {text}");
}

#[tokio::test]
async fn login_with_no_host_is_refused_clearly() {
    let routes = routes(&["friends.example.com"]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let r = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, r).await;
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client
        .write_all(&handshake("friends.example.com", 2))
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf)).await;
    let text = String::from_utf8_lossy(&buf);
    assert!(text.contains("waking up"), "got: {text}");
}

#[tokio::test]
async fn slot_for_the_wrong_host_is_rejected() {
    let routes = routes(&["friends.example.com"]);
    let tunnel = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tunnel.local_addr().unwrap();
    let routes_for_tunnel = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = tunnel.accept().await.unwrap();
        let _ = nomad_relay::handle_slot_for_test(stream, routes_for_tunnel).await;
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client.write_all(b"SLOT wrong.example.com\n").await.unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf)).await;
    assert!(String::from_utf8_lossy(&buf).contains("ERR"));
}

/// A host that takes over a room must evict the previous host's warm slots.
///
/// Otherwise a player could land in a socket that leads to the old, now-unauthoritative
/// world and play a fork. The first slot from a new host generation clears the old
/// generation entirely.
#[tokio::test]
async fn a_new_host_evicts_the_previous_hosts_slots() {
    let routes = routes(&["friends.example.com"]);
    let registry = routes[&"friends.example.com".to_string()].registry.clone();

    let old = park_slots(&registry, "epoch-1", 2).await;
    assert_eq!(registry.available().await, 2);
    assert_eq!(registry.owner().await.as_deref(), Some("epoch-1"));

    let evicted = {
        let (slot, _client) = connected_pair().await;
        registry.park(slot, "epoch-2").await
    };

    assert_eq!(evicted, 2, "both old-generation slots must be dropped");
    assert_eq!(registry.available().await, 1, "only the new host remains");
    assert_eq!(registry.owner().await.as_deref(), Some("epoch-2"));

    // Keep the old peer sockets alive until the assertions are done.
    drop(old);
}

/// Park `count` slots for a host token, returning the client-side peers so they stay
/// open for the duration of the test.
async fn park_slots(registry: &Arc<Registry>, token: &str, count: usize) -> Vec<TcpStream> {
    let mut peers = Vec::new();
    for _ in 0..count {
        let (slot, client) = connected_pair().await;
        registry.park(slot, token).await;
        peers.push(client);
    }
    peers
}

/// A connected TCP pair: returns `(server_side, client_side)`.
async fn connected_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (accepted, client) = tokio::join!(
        async {
            let (s, _) = listener.accept().await.unwrap();
            s
        },
        async { TcpStream::connect(addr).await.unwrap() }
    );
    (accepted, client)
}

#[test]
fn player_names_are_read_from_the_first_hostname_label() {
    assert_eq!(
        nomad_relay::split_player_room("alex.friends.example.com"),
        Some(("alex".into(), "friends.example.com".into()))
    );
    // Case is normalized, so two spellings of the same name are the same player.
    assert_eq!(
        nomad_relay::split_player_room("ALEX.Friends.Example.Com"),
        Some(("alex".into(), "friends.example.com".into()))
    );
    // A bare multi-label host splits too, but the caller only treats it as a player
    // when the remainder is a known room (see `serve_player`). Document that here so
    // the two halves stay honest about their contract.
    assert_eq!(
        nomad_relay::split_player_room("friends.example.com"),
        Some(("friends".into(), "example.com".into()))
    );
    // A single label has no dot, so there is no player to extract.
    assert_eq!(nomad_relay::split_player_room("localhost"), None);
}

/// A tiny stand-in for the control plane's `/admit` endpoint.
async fn fake_door(allowed: &'static [&'static str]) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                // The player name is the JSON value; a crude but sufficient parse.
                let allowed_here = allowed.iter().any(|p| req.contains(&format!("{p}\"")));
                let body = if allowed_here {
                    "{\"admitted\":true}"
                } else {
                    "{}"
                };
                let status = if allowed_here {
                    "200 OK"
                } else {
                    "403 Forbidden"
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn a_door_refuses_a_player_it_does_not_know() {
    let door_addr = fake_door(&["alex"]).await;
    let mut r = route("friends.example.com");
    r.door = Some(nomad_relay::Door::new(format!("http://{door_addr}")));
    let routes: Arc<HashMap<String, RoomRoute>> = Arc::new(
        [("friends.example.com".to_string(), r)]
            .into_iter()
            .collect(),
    );

    // mallory is not on the list: the relay must refuse before looking for a host.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public = listener.local_addr().unwrap();
    let rs = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, rs).await;
    });

    let mut client = TcpStream::connect(public).await.unwrap();
    client
        .write_all(&handshake("mallory.friends.example.com", 2))
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf)).await;
    let text = String::from_utf8_lossy(&buf);
    assert!(
        text.contains("join the room"),
        "expected a door refusal, got: {text}"
    );
}

#[tokio::test]
async fn a_door_admits_a_listed_player_and_then_routes() {
    let door_addr = fake_door(&["alex"]).await;
    let game = fake_game_server().await;

    let mut r = route("friends.example.com");
    r.door = Some(nomad_relay::Door::new(format!("http://{door_addr}")));
    let routes: Arc<HashMap<String, RoomRoute>> = Arc::new(
        [("friends.example.com".to_string(), r)]
            .into_iter()
            .collect(),
    );

    // Park a host slot for the room.
    let tunnel = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tunnel_addr = tunnel.local_addr().unwrap();
    let rs_tunnel = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = tunnel.accept().await.unwrap();
        let _ = nomad_relay::handle_slot_for_test(stream, rs_tunnel).await;
    });
    connect_host(tunnel_addr, "friends.example.com", game).await;
    for _ in 0..200 {
        if routes[&"friends.example.com".to_string()]
            .registry
            .available()
            .await
            > 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public = listener.local_addr().unwrap();
    let rs = routes.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = nomad_relay::serve_player(stream, rs).await;
    });

    let mut client = TcpStream::connect(public).await.unwrap();
    // alex is admitted by the door, then spliced to the host.
    client
        .write_all(&handshake("alex.friends.example.com", 2))
        .await
        .unwrap();
    client.write_all(b"hello-through-door").await.unwrap();

    let mut buf = vec![0u8; "hello-through-door".len()];
    tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut buf))
        .await
        .expect("admitted player must reach the host")
        .unwrap();
    assert_eq!(&buf, b"hello-through-door");
}
