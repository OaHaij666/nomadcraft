//! The relay side of the door.
//!
//! The relay does not decide who may play — the control plane does, because that is
//! where membership lives. But the relay is the only component that sees a raw
//! client connect, so it is the only place the decision can be enforced. So on each
//! login the relay asks the control plane "may this player enter this room?" and
//! refuses the connection on anything but a clear yes.
//!
//! ## How the player identifies itself
//!
//! A Minecraft client can only tell us things through the address it connects to.
//! We use that: players connect as `<player>.<room-host>` (for example
//! `alex.friends.example.com`), and the relay reads the leading label as the player
//! name. A client that connects to the bare room host bypasses the player label, so
//! a room that enforces membership will refuse it.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Why a door check could not produce a clear answer.
#[derive(Debug, thiserror::Error)]
pub enum DoorError {
    #[error("door transport error: {0}")]
    Transport(String),
    #[error("door refused to answer: HTTP {status}")]
    Refused { status: u16 },
    #[error("door response was not understood: {0}")]
    Decode(String),
}

/// A handle to the control plane's door.
#[derive(Clone)]
pub struct Door {
    /// Base URL, e.g. `http://127.0.0.1:8787`.
    base: String,
    timeout: Duration,
}

/// The answer to an admission question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// The player may enter.
    Allowed,
    /// The room does not know this player; refuse the connection.
    Denied,
    /// The control plane could not be reached. We fail closed so an outage never
    /// silently opens every room.
    Unavailable,
}

impl Door {
    /// Point a door at a control plane.
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            timeout: Duration::from_secs(5),
        }
    }

    /// Ask whether `player` may enter `room_id`.
    ///
    /// Returns [`Admission::Unavailable`] rather than an error so the caller has one
    /// decision to make: anything that is not a clear "allowed" is a refusal.
    pub async fn admit(&self, room_id: &str, player: &str) -> Admission {
        match self.ask(room_id, player).await {
            Ok(Admission::Allowed) => Admission::Allowed,
            Ok(Admission::Denied) => Admission::Denied,
            Ok(Admission::Unavailable) => Admission::Unavailable,
            Err(_) => Admission::Unavailable,
        }
    }

    async fn ask(&self, room_id: &str, player: &str) -> Result<Admission, DoorError> {
        let (host, port) = parse_host_port(&self.base)?;
        let body = serde_json::json!({ "player": player }).to_string();
        let path = format!("/v1/rooms/{room_id}/admit");
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );

        let fut = async {
            let mut stream = TcpStream::connect((host.as_str(), port)).await?;
            stream.write_all(request.as_bytes()).await?;
            stream.write_all(body.as_bytes()).await?;
            stream.flush().await?;
            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await?;
            Ok::<_, std::io::Error>(raw)
        };

        let raw = match tokio::time::timeout(self.timeout, fut).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(e)) => return Err(DoorError::Transport(e.to_string())),
            Err(_) => return Err(DoorError::Transport("request timed out".into())),
        };

        let status = parse_status(&raw)?;
        match status {
            200..=299 => Ok(Admission::Allowed),
            403 | 404 => Ok(Admission::Denied),
            other => Err(DoorError::Refused { status: other }),
        }
    }
}

fn parse_host_port(base: &str) -> Result<(String, u16), DoorError> {
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| DoorError::Transport(format!("unsupported URL scheme: {base}")))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| DoorError::Transport(format!("bad port in {base}")))?;
            Ok((h.to_string(), port))
        }
        None => Ok((authority.to_string(), 80)),
    }
}

fn parse_status(raw: &[u8]) -> Result<u16, DoorError> {
    let head_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| DoorError::Decode("no header terminator".into()))?;
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let status_line = head.lines().next().unwrap_or_default();
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| DoorError::Decode(format!("bad status line: {status_line}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_and_port() {
        assert_eq!(
            parse_host_port("http://127.0.0.1:8787").unwrap(),
            ("127.0.0.1".into(), 8787)
        );
        assert_eq!(
            parse_host_port("http://door.example").unwrap(),
            ("door.example".into(), 80)
        );
        assert!(parse_host_port("https://x").is_err());
    }

    #[test]
    fn parses_status_line() {
        let raw = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse_status(raw).unwrap(), 403);
    }
}
