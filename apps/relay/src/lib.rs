//! NomadCraft relay: the fixed front door.
//!
//! Players connect to one public address and are routed to whichever machine is
//! hosting their room. The relay looks like an ordinary Minecraft server on the
//! server list, but it runs no game: it answers the status ping itself and forwards
//! every other byte untouched.
//!
//! ## Why we read the handshake
//!
//! One public port must serve many rooms, and we must show a live server list. Both
//! fall out of the single opening packet the client sends. It carries the address
//! the player typed, which is the room, and the intent, which says whether this is a
//! status ping or a real login. Reading that one packet is the whole trick; after it
//! we are a dumb pipe again.
//!
//! ## Hosts dial out
//!
//! A host cannot accept inbound connections, so it dials the relay and parks a warm
//! slot already wired to its local game server. A login is spliced into a free slot.
//!
//! ## Wire format (tunnel port)
//!
//! Line-based and telnet-debuggable:
//!
//! ```text
//! host -> relay :  SLOT <hostname>\n
//! relay -> host :  OK\n
//! ```

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nomad_mcproto::{status_json, try_read_handshake, Intent, StatusResponse};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// Registry for a single room's status and warm slots.
#[derive(Default)]
pub struct Registry {
    slots: Mutex<VecDeque<ParkedSlot>>,
}

struct ParkedSlot {
    stream: TcpStream,
    parked: Instant,
}

/// How long an unused slot stays parked before being dropped.
const SLOT_IDLE: Duration = Duration::from_secs(120);

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Park a host slot.
    pub async fn park(&self, stream: TcpStream) {
        self.slots.lock().await.push_back(ParkedSlot {
            stream,
            parked: Instant::now(),
        });
    }

    /// Take the next live slot, discarding any that sat idle too long.
    async fn take(&self) -> Option<TcpStream> {
        let mut slots = self.slots.lock().await;
        while let Some(slot) = slots.pop_front() {
            if slot.parked.elapsed() <= SLOT_IDLE {
                return Some(slot.stream);
            }
        }
        None
    }

    /// Number of free slots.
    pub async fn available(&self) -> usize {
        self.slots.lock().await.len()
    }
}

/// One room the relay can route to.
pub struct RoomRoute {
    /// Human-readable room id, for logs.
    pub room_id: String,
    /// What the server list should show while asleep or when the host is unknown.
    pub motd_offline: String,
    /// What the server list shows while a host is live.
    pub motd_online: String,
    /// The Minecraft version string to advertise.
    pub version_name: String,
    pub max_players: u32,
    /// Warm host slots for this room.
    pub registry: Arc<Registry>,
}

/// Error types for the relay.
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not parse the client handshake: {0}")]
    Protocol(#[from] nomad_mcproto::ProtocolError),
    #[error("no room is configured for {0}")]
    UnknownRoom(String),
    #[error("no host is currently serving this room")]
    NoHost,
}

/// Read a newline-terminated header from a raw socket without over-reading.
async fn read_line_raw(stream: &mut TcpStream, max: usize) -> Result<String, RelayError> {
    let mut buf = Vec::with_capacity(32);
    loop {
        if buf.len() >= max {
            return Err(RelayError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "header too long",
            )));
        }
        let mut byte = [0u8; 1];
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(RelayError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "closed during header",
            )));
        }
        if byte[0] == b'\n' {
            break;
        }
        if byte[0] != b'\r' {
            buf.push(byte[0]);
        }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Read a host's `SLOT <hostname>` header and return the parked socket.
pub async fn accept_slot(
    mut stream: TcpStream,
    expected_host: &str,
) -> Result<TcpStream, RelayError> {
    let line = read_line_raw(&mut stream, 512).await?;
    let host = line
        .strip_prefix("SLOT ")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if host != expected_host.to_ascii_lowercase() {
        stream.write_all(b"ERR wrong host\n").await?;
        return Err(RelayError::UnknownRoom(host));
    }
    stream.write_all(b"OK\n").await?;
    Ok(stream)
}

/// Handle one player connection end to end.
///
/// Reads the opening handshake into a small buffer — never more, so no game bytes are
/// consumed — then either answers a status ping or routes a login to the current host,
/// replaying the exact handshake bytes so the tunnel is indistinguishable from a
/// direct connection.
pub async fn serve_player(
    mut player: TcpStream,
    routes: Arc<HashMap<String, RoomRoute>>,
) -> Result<(), RelayError> {
    // Read only the handshake. We accumulate bytes until it parses; a Minecraft
    // handshake is well under 512 bytes.
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let (handshake, consumed) = loop {
        match try_read_handshake(&buf)? {
            Some(found) => break found,
            None => {
                if buf.len() >= 1024 {
                    let _ = write_disconnect(&mut player, "bad handshake").await;
                    return Err(RelayError::UnknownRoom("<oversized handshake>".into()));
                }
                let mut chunk = [0u8; 256];
                let n = player.read(&mut chunk).await?;
                if n == 0 {
                    return Err(RelayError::Io(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "client closed during handshake",
                    )));
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    };

    let host = handshake.hostname();
    let Some(route) = routes.get(&host) else {
        let _ = write_disconnect(&mut player, "未知的房间 / unknown room").await;
        return Err(RelayError::UnknownRoom(host));
    };

    if handshake.intent == Intent::Status {
        // Answer the ping ourselves so the list is always alive.
        let online = route.registry.available().await as u32;
        let motd = if online > 0 {
            route.motd_online.clone()
        } else {
            route.motd_offline.clone()
        };
        let status = StatusResponse::for_room(
            &motd,
            handshake.protocol_version,
            &route.version_name,
            online,
            route.max_players,
            vec![],
        );
        // The client's status-request packet is very likely already in our buffer,
        // past the handshake. Hand it over so we never block waiting on the socket.
        answer_status(&mut player, &buf[consumed..], &status).await?;
        return Ok(());
    }

    // A login: pair with a warm host slot and splice.
    let Some(mut host_conn) = route.registry.take().await else {
        let _ = write_disconnect(&mut player, "世界正在唤醒，请稍后重连 / waking up").await;
        return Err(RelayError::NoHost);
    };

    // Replay exactly the handshake bytes, then forward any bytes that were already in
    // our buffer past the handshake (the client may have sent more).
    host_conn.write_all(&buf[..consumed]).await?;
    if buf.len() > consumed {
        host_conn.write_all(&buf[consumed..]).await?;
    }
    host_conn.flush().await?;

    let (mut pr, mut pw) = player.split();
    let (mut hr, mut hw) = host_conn.split();
    let up = async { tokio::io::copy(&mut pr, &mut hw).await };
    let down = async { tokio::io::copy(&mut hr, &mut pw).await };
    tokio::select! {
        r = up => { r?; }
        r = down => { r?; }
    }
    Ok(())
}

/// Write a minimal disconnect message and close.
///
/// A full login-state disconnect packet would be nicer, but the MVP client shows a
/// connection error either way, and building it means knowing the client's protocol
/// version at login time. Stated as a known simplification.
async fn write_disconnect(player: &mut TcpStream, reason: &str) -> std::io::Result<()> {
    player.write_all(reason.as_bytes()).await?;
    player.flush().await
}

/// Answer a status ping.
///
/// The client sends a handshake (already parsed) and then an empty *Status Request*
/// packet; the server replies with a *Status Response* packet whose body is the JSON
/// document as a length-prefixed string. Both are framed with a varint length.
async fn answer_status(
    player: &mut TcpStream,
    already_buffered: &[u8],
    status: &StatusResponse,
) -> std::io::Result<()> {
    // Consume the client's status-request packet if we do not already have it. The
    // packet is `[len varint][id varint = 0]`, one or two bytes in practice.
    if already_buffered.is_empty() {
        let mut first = [0u8; 1];
        if player.read(&mut first).await? == 1 {
            let remaining = first[0] as usize;
            if remaining > 0 && remaining < 128 {
                let mut discard = vec![0u8; remaining];
                let _ = player.read_exact(&mut discard).await;
            }
        }
    }

    // The status response body is the JSON document as a length-prefixed string,
    // wrapped in a packet with id 0x00.
    let json = status_json(status);
    let body = nomad_mcproto::encode_string(&json);
    let packet = nomad_mcproto::encode_packet(0x00, &body);
    player.write_all(&packet).await?;
    player.flush().await
}

/// Run the relay for a set of rooms.
///
/// A single public port serves every room; the room is chosen by the hostname the
/// client connects with. One tunnel port accepts hosts, which announce the room they
/// serve in their `SLOT` header.
pub async fn run_rooms(
    public_addr: &str,
    tunnel_addr: &str,
    routes: Vec<RoomRoute>,
) -> anyhow::Result<()> {
    let route_map: Arc<HashMap<String, RoomRoute>> = Arc::new(
        routes
            .into_iter()
            .map(|r| (r.room_id.to_ascii_lowercase(), r))
            .collect(),
    );

    let public = tokio::net::TcpListener::bind(public_addr).await?;
    let tunnel = tokio::net::TcpListener::bind(tunnel_addr).await?;
    tracing::info!(
        %public_addr,
        %tunnel_addr,
        rooms = route_map.len(),
        "relay listening"
    );

    // Tunnel side: a host announces its room, then parks a warm slot.
    let routes_for_tunnel = route_map.clone();
    let tunnel_task = tokio::spawn(async move {
        loop {
            match tunnel.accept().await {
                Ok((stream, peer)) => {
                    let routes = routes_for_tunnel.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_slot(stream, routes).await {
                            tracing::debug!(%peer, "slot ended: {e}");
                        }
                    });
                }
                Err(e) => tracing::warn!("tunnel accept failed: {e}"),
            }
        }
    });

    // Public side: players arrive here.
    let public_task = tokio::spawn(async move {
        loop {
            match public.accept().await {
                Ok((stream, peer)) => {
                    let routes = route_map.clone();
                    tokio::spawn(async move {
                        if let Err(e) = serve_player(stream, routes).await {
                            tracing::debug!(%peer, "player session ended: {e}");
                        }
                    });
                }
                Err(e) => tracing::warn!("public accept failed: {e}"),
            }
        }
    });

    tokio::select! {
        _ = tunnel_task => {}
        _ = public_task => {}
    }
    Ok(())
}

/// Test-facing alias for [`handle_slot`], which stays private to keep the surface small.
pub async fn handle_slot_for_test(
    stream: TcpStream,
    routes: Arc<HashMap<String, RoomRoute>>,
) -> Result<(), RelayError> {
    handle_slot(stream, routes).await
}

/// Read a host's SLOT header and park the slot on the right room.
async fn handle_slot(
    mut stream: TcpStream,
    routes: Arc<HashMap<String, RoomRoute>>,
) -> Result<(), RelayError> {
    let line = read_line_raw(&mut stream, 512).await?;
    let host = line
        .strip_prefix("SLOT ")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let Some(route) = routes.get(&host) else {
        stream.write_all(b"ERR unknown room\n").await?;
        return Err(RelayError::UnknownRoom(host));
    };
    stream.write_all(b"OK\n").await?;
    tracing::info!(room = %route.room_id, "host slot parked");
    route.registry.park(stream).await;
    Ok(())
}
