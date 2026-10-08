//! What the control plane knows about an enrolled machine.

use serde::{Deserialize, Serialize};

use crate::ids::NodeId;

/// Static facts reported when a machine enrolls, used by the placement scorer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeCapabilities {
    /// "windows" | "linux" | "macos"
    pub os: String,
    /// "x86_64" | "aarch64"
    pub arch: String,
    /// Logical CPU cores.
    pub cpu_cores: u32,
    /// Total physical memory.
    pub total_memory_mb: u64,
    /// Free space on the data volume, refreshed on each heartbeat.
    pub disk_free_bytes: u64,
    /// Measured or user-declared uplink, in megabits per second.
    pub uplink_mbps: f64,
    /// Whether the user has opted this machine in as a possible host.
    pub hosting_enabled: bool,
    /// Whether this machine is an always-on replica that holds the latest save.
    pub anchor: bool,
}

/// Liveness as seen by the control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeState {
    /// Registered, heartbeat healthy.
    Online,
    /// Missed heartbeats but not yet written off.
    Suspect,
    /// Lease revoked; must not be trusted to host.
    Offline,
}

/// A minimal view of a node handed back to agents so they can reach each other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {
    pub node_id: NodeId,
    pub name: String,
    /// Ed25519 public key (base64). Peers pin this instead of using a CA.
    pub public_key: String,
}
