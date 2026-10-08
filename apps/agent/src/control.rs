//! Talking to the control plane.
//!
//! The agent is a client, never a decision-maker: it registers, heartbeats, asks for
//! a lease, and obeys the answer. Everything here is a thin, typed wrapper over the
//! control-plane REST API so the rest of the agent can stay readable.
//!
//! The HTTP client is deliberately minimal — an MVP only ever talks to our own
//! control plane over plain HTTP (localhost, a LAN box, or behind a tunnel). Swapping
//! in a full stack later is a one-file change because the typed surface stays put.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Errors from the control-plane client.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("transport error: {0}")]
    Transport(String),
    #[error("control plane refused: {status} {body}")]
    Refused { status: u16, body: String },
    #[error("invalid response: {0}")]
    Decode(String),
}

/// What the control plane returns when hosting is granted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lease {
    pub server_id: String,
    pub node_id: String,
    pub epoch: u64,
    pub expires_at_unix_ms: i64,
    #[serde(default)]
    pub restore_snapshot: Option<String>,
}

/// What the control plane returns when a node registers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegisteredNode {
    pub node_id: String,
    #[serde(default)]
    pub anchor: bool,
}

/// What the control plane returns when a server is created.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerInfo {
    pub server_id: String,
    pub room_id: String,
    pub epoch: u64,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub committed_snapshot: Option<String>,
}

/// The facts a node reports when it registers.
#[derive(Debug, Clone, Serialize)]
pub struct NodeRegistration {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub public_key: String,
    pub os: String,
    pub arch: String,
    pub cpu_cores: u32,
    pub memory_mb: u64,
    pub disk_free_bytes: u64,
    pub uplink_mbps: f64,
    pub hosting_enabled: bool,
    pub anchor: bool,
}

/// A minimal HTTP/1.1 client for the control plane.
#[derive(Debug, Clone)]
pub struct ControlClient {
    base: String,
    timeout: Duration,
}

impl ControlClient {
    /// Point a client at a control-plane base URL such as `http://127.0.0.1:8787`.
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            timeout: Duration::from_secs(10),
        }
    }

    /// The configured base URL.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Build an endpoint URL.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Register this machine. Returns the assigned node id.
    pub async fn register(&self, reg: &NodeRegistration) -> Result<RegisteredNode, ControlError> {
        let body = serde_json::to_vec(reg).map_err(|e| ControlError::Decode(e.to_string()))?;
        let text = self
            .request("POST", "/v1/nodes/register", Some(body))
            .await?;
        serde_json::from_slice(&text).map_err(|e| ControlError::Decode(e.to_string()))
    }

    /// Create a server in a room; returns its id and current state.
    pub async fn create_server(&self, name: &str) -> Result<ServerInfo, ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({ "name": name }))
            .map_err(|e| ControlError::Decode(e.to_string()))?;
        let text = self.request("POST", "/v1/servers", Some(body)).await?;
        serde_json::from_slice(&text).map_err(|e| ControlError::Decode(e.to_string()))
    }

    /// Read a server's current state.
    pub async fn get_server(&self, server_id: &str) -> Result<ServerInfo, ControlError> {
        let text = self
            .request("GET", &format!("/v1/servers/{server_id}"), None)
            .await?;
        serde_json::from_slice(&text).map_err(|e| ControlError::Decode(e.to_string()))
    }

    /// Ask to become host. Pass `None` to let the control plane choose.
    pub async fn claim_host(
        &self,
        server_id: &str,
        node_id: Option<&str>,
    ) -> Result<Lease, ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({ "node_id": node_id }))
            .map_err(|e| ControlError::Decode(e.to_string()))?;
        let text = self
            .request(
                "POST",
                &format!("/v1/servers/{server_id}/claim"),
                Some(body),
            )
            .await?;
        serde_json::from_slice(&text).map_err(|e| ControlError::Decode(e.to_string()))
    }

    /// Renew a held lease.
    pub async fn renew_lease(
        &self,
        server_id: &str,
        node_id: &str,
        epoch: u64,
    ) -> Result<Lease, ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({ "node_id": node_id, "epoch": epoch }))
            .map_err(|e| ControlError::Decode(e.to_string()))?;
        let text = self
            .request(
                "POST",
                &format!("/v1/servers/{server_id}/renew"),
                Some(body),
            )
            .await?;
        serde_json::from_slice(&text).map_err(|e| ControlError::Decode(e.to_string()))
    }

    /// Release hosting so another machine can take over.
    pub async fn release_host(
        &self,
        server_id: &str,
        node_id: &str,
        epoch: u64,
        reason: &str,
    ) -> Result<(), ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "node_id": node_id,
            "epoch": epoch,
            "reason": reason
        }))
        .map_err(|e| ControlError::Decode(e.to_string()))?;
        self.request(
            "POST",
            &format!("/v1/servers/{server_id}/release"),
            Some(body),
        )
        .await?;
        Ok(())
    }

    /// Commit a checkpoint as the authoritative save.
    pub async fn commit_checkpoint(
        &self,
        server_id: &str,
        node_id: &str,
        epoch: u64,
        snapshot_id: &str,
        reason: &str,
    ) -> Result<(), ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "node_id": node_id,
            "epoch": epoch,
            "snapshot_id": snapshot_id,
            "reason": reason
        }))
        .map_err(|e| ControlError::Decode(e.to_string()))?;
        self.request(
            "POST",
            &format!("/v1/servers/{server_id}/checkpoint"),
            Some(body),
        )
        .await?;
        Ok(())
    }

    /// Perform one HTTP request and return the response body.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, ControlError> {
        let (host, port) = parse_host_port(&self.base)?;
        let body = body.unwrap_or_default();

        let fut = async {
            let mut stream = TcpStream::connect((host.as_str(), port)).await?;
            let mut req =
                format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n");
            if !body.is_empty() {
                req.push_str(&format!(
                    "Content-Type: application/json\r\nContent-Length: {}\r\n",
                    body.len()
                ));
            }
            req.push_str("\r\n");
            stream.write_all(req.as_bytes()).await?;
            stream.write_all(&body).await?;
            stream.flush().await?;

            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await?;
            Ok::<_, std::io::Error>(raw)
        };

        let raw = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| ControlError::Transport("request timed out".into()))?
            .map_err(|e| ControlError::Transport(e.to_string()))?;

        let (status, resp_body) = parse_http_response(&raw)?;
        if !(200..300).contains(&status) {
            return Err(ControlError::Refused {
                status,
                body: String::from_utf8_lossy(&resp_body).to_string(),
            });
        }
        Ok(resp_body)
    }
}

/// Split a base URL into host and port. Only `http://` is supported.
fn parse_host_port(base: &str) -> Result<(String, u16), ControlError> {
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| ControlError::Transport(format!("unsupported URL scheme: {base}")))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| ControlError::Transport(format!("bad port in {base}")))?;
            Ok((h.to_string(), port))
        }
        None => Ok((authority.to_string(), 80)),
    }
}

/// Parse an HTTP/1.1 response into (status code, body).
fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), ControlError> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let Some(header_end) = split else {
        return Err(ControlError::Decode("no header terminator".into()));
    };
    let header = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = header.lines();
    let status_line = lines.next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ControlError::Decode(format!("bad status line: {status_line}")))?;

    let mut body = raw[header_end + 4..].to_vec();
    // Honor Content-Length when present; otherwise take what we read.
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                if let Ok(len) = v.trim().parse::<usize>() {
                    body.truncate(len);
                }
            }
        }
    }
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_joining_is_clean() {
        let c = ControlClient::new("http://example.test/");
        assert_eq!(c.base(), "http://example.test");
        assert_eq!(c.url("/v1/nodes"), "http://example.test/v1/nodes");
    }

    #[test]
    fn parses_host_and_port() {
        assert_eq!(
            parse_host_port("http://127.0.0.1:8787").unwrap(),
            ("127.0.0.1".into(), 8787)
        );
        assert_eq!(
            parse_host_port("http://example.test").unwrap(),
            ("example.test".into(), 80)
        );
        assert!(parse_host_port("https://x").is_err());
    }

    #[test]
    fn parses_a_json_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"epoch\":3}\r\n";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"{\"epoch\":3}");
    }

    #[test]
    fn parses_a_204_with_no_body() {
        let raw = b"HTTP/1.1 204 No Content\r\n\r\n";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 204);
        assert!(body.is_empty());
    }

    #[test]
    fn lease_deserializes_from_control_plane_shape() {
        let raw = r#"{"server_id":"srv_1","node_id":"node_1","epoch":3,"expires_at_unix_ms":123,"restore_snapshot":"snap_a"}"#;
        let lease: Lease = serde_json::from_str(raw).unwrap();
        assert_eq!(lease.epoch, 3);
        assert_eq!(lease.restore_snapshot.as_deref(), Some("snap_a"));
    }

    #[test]
    fn registration_omits_a_null_node_id() {
        let reg = NodeRegistration {
            name: "pc".into(),
            node_id: None,
            public_key: "pk".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            cpu_cores: 8,
            memory_mb: 16384,
            disk_free_bytes: 0,
            uplink_mbps: 20.0,
            hosting_enabled: true,
            anchor: false,
        };
        let json = serde_json::to_value(&reg).unwrap();
        assert!(json.get("node_id").is_none());
    }
}
