//! NomadCraft relay.
//!
//! The relay is the fixed front door. Players connect to one stable address; the
//! relay forwards their raw TCP to whichever machine currently hosts the room.
//!
//! It is deliberately dumb: it never parses Minecraft, never holds world state,
//! and never decides who hosts. That is what lets it run on a tiny box.
//!
//! ## Why a tunnel at all
//!
//! A host machine cannot accept inbound connections: it sits behind NAT and may
//! have no public IP. So the host dials *out* to the relay and keeps that
//! connection open. Because the host always initiates, no port forwarding and no
//! public IP are ever required.
//!
//! ## Warm slots
//!
//! The host opens a small pool of outbound connections and wires each one
//! straight through to its local game server. The relay parks them; when a player
//! connects it pairs the player with the next free slot and splices bytes. Neither
//! side learns the other's address.
//!
//! ## Wire format (tunnel port)
//!
//! Line-based and telnet-debuggable. A slot announces itself, then becomes raw:
//!
//! ```text
//! host -> relay :  SLOT room_abc\n
//! relay -> host :  OK\n
//! ```
//!
//! Headers are read **one byte at a time** so the socket never over-reads past the
//! newline. Splice then starts from a clean stream; that small cost buys correctness
//! without a buffer-recombining dance.
//!
//! ## Routing
//!
//! One relay process serves one room, named by `--room`. Multiplexing many rooms
//! from one address means reading the hostname out of the Minecraft handshake;
//! keeping that out of the data path is deliberate.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// How long the relay keeps an unused slot parked before closing it, so a long-idle
/// host does not accumulate dead sockets.
const SLOT_IDLE: Duration = Duration::from_secs(120);

/// Parks warm host slots.
#[derive(Default)]
pub struct Registry {
    slots: Mutex<VecDeque<ParkedSlot>>,
}

/// A parked slot plus the time it was parked, for idle eviction.
struct ParkedSlot {
    stream: TcpStream,
    parked: std::time::Instant,
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Park a slot.
    pub async fn park(&self, stream: TcpStream) {
        self.slots.lock().await.push_back(ParkedSlot {
            stream,
            parked: std::time::Instant::now(),
        });
    }

    /// Take the next free slot, dropping any that sat idle too long.
    async fn take(&self) -> Option<TcpStream> {
        let mut slots = self.slots.lock().await;
        while let Some(slot) = slots.pop_front() {
            if slot.parked.elapsed() <= SLOT_IDLE {
                return Some(slot.stream);
            }
            // Expired: drop it and try the next.
        }
        None
    }

    /// Number of free slots.
    pub async fn available(&self) -> usize {
        self.slots.lock().await.len()
    }
}

/// Error types for the relay.
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unexpected header: {0}")]
    BadHeader(String),
    #[error("no host is currently serving this room")]
    NoHost,
}

/// Read a single newline-terminated line from a raw TCP stream, one byte at a
/// time, so no game bytes are consumed along with the header.
async fn read_line_raw(stream: &mut TcpStream, max: usize) -> Result<String, RelayError> {
    let mut buf = Vec::with_capacity(32);
    loop {
        if buf.len() >= max {
            return Err(RelayError::BadHeader("header too long".into()));
        }
        let mut byte = [0u8; 1];
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(RelayError::BadHeader("connection closed".into()));
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

/// Read a host's `SLOT <room>` header and park the socket as a warm slot.
///
/// Returns the parked stream to the caller so the accept loop can hand it to the
/// registry (and tests can inspect it).
pub async fn accept_slot(
    mut stream: TcpStream,
    expected_room: &str,
) -> Result<TcpStream, RelayError> {
    let line = read_line_raw(&mut stream, 256).await?;
    let room = line.strip_prefix("SLOT ").unwrap_or("");
    if room != expected_room {
        stream.write_all(b"ERR wrong room\n").await?;
        return Err(RelayError::BadHeader(format!("slot for {room:?}")));
    }
    stream.write_all(b"OK\n").await?;
    Ok(stream)
}

/// Pair one player with a host slot and splice bytes both ways.
///
/// Blocks until either side closes. On success the slot is finished (it carried a
/// whole player session) and is not returned; the host replaces it with a fresh
/// one. This keeps the model dead simple: one slot, one session.
pub async fn serve_player(
    mut player: TcpStream,
    registry: Arc<Registry>,
) -> Result<(), RelayError> {
    let Some(mut host) = registry.take().await else {
        // No host is up. Tell the player plainly; the launcher retries.
        player.write_all(b"NOMAD_NO_HOST\n").await.ok();
        return Err(RelayError::NoHost);
    };

    let (mut pr, mut pw) = player.split();
    let (mut hr, mut hw) = host.split();

    let up = async { tokio::io::copy(&mut pr, &mut hw).await };
    let down = async { tokio::io::copy(&mut hr, &mut pw).await };

    tokio::select! {
        r = up => { r?; }
        r = down => { r?; }
    }
    Ok(())
}

/// Convenience: run the relay's two listeners against a room.
pub async fn run(public_addr: &str, tunnel_addr: &str, room: String) -> anyhow::Result<()> {
    let registry = Registry::new();
    let public = tokio::net::TcpListener::bind(public_addr).await?;
    let tunnel = tokio::net::TcpListener::bind(tunnel_addr).await?;
    tracing::info!(%public_addr, %tunnel_addr, %room, "relay listening");

    let reg_tunnel = registry.clone();
    let room_for_tunnel = room.clone();
    let tunnel_task = tokio::spawn(async move {
        loop {
            match tunnel.accept().await {
                Ok((stream, peer)) => {
                    let reg = reg_tunnel.clone();
                    let want = room_for_tunnel.clone();
                    tokio::spawn(async move {
                        match accept_slot(stream, &want).await {
                            Ok(slot) => {
                                tracing::info!(%peer, "slot parked");
                                reg.park(slot).await;
                            }
                            Err(e) => tracing::warn!(%peer, "slot rejected: {e}"),
                        }
                    });
                }
                Err(e) => tracing::warn!("tunnel accept failed: {e}"),
            }
        }
    });

    let reg_public = registry.clone();
    let public_task = tokio::spawn(async move {
        loop {
            match public.accept().await {
                Ok((stream, peer)) => {
                    let reg = reg_public.clone();
                    tokio::spawn(async move {
                        if let Err(e) = serve_player(stream, reg).await {
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
