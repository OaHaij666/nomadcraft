//! The agent <-> control-plane control channel.
//!
//! Only control traffic flows here: heartbeats, lease grants, fencing, routing
//! updates, and world-version notifications. Game bytes never touch this channel
//! (they travel over the relay), and world files are fetched out-of-band.
//!
//! Messages are tagged JSON for now; the enum shape keeps a future protobuf move
//! mechanical.

use serde::{Deserialize, Serialize};

use crate::epoch::Epoch;
use crate::ids::{NodeId, RoomId, ServerId, SnapshotId};
use crate::node::NodeCapabilities;
use crate::room::{Lease, LeaseRole, ServerDesired};

/// Agent -> control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToCp {
    /// First message after connecting; announces who we are and what we can do.
    Hello {
        protocol_version: u32,
        node_id: NodeId,
        room_id: RoomId,
        agent_version: String,
        capabilities: NodeCapabilities,
    },
    /// Periodic liveness. Carries volatile metrics the scorer may use.
    Heartbeat {
        node_id: NodeId,
        /// Epoch we currently believe we hold. Lets the CP detect stale hosts.
        epoch: Epoch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lease_role: Option<LeaseRole>,
        metrics: NodeMetrics,
    },
    /// Ask to become host (a player pressed "play", or the scheduler woke us).
    ClaimHost {
        node_id: NodeId,
        room_id: RoomId,
        server_id: ServerId,
    },
    /// Voluntary handoff: "I'm leaving, save and move hosting."
    ReleaseHost {
        node_id: NodeId,
        server_id: ServerId,
        epoch: Epoch,
        reason: String,
    },
    /// A snapshot finished uploading and is safe to consider committed.
    CheckpointDone {
        node_id: NodeId,
        server_id: ServerId,
        epoch: Epoch,
        snapshot_id: SnapshotId,
        reason: String,
    },
    /// The server process reached a clean stop.
    ServerStopped {
        node_id: NodeId,
        server_id: ServerId,
        epoch: Epoch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_snapshot: Option<SnapshotId>,
    },
}

/// Volatile facts refreshed on every heartbeat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeMetrics {
    pub disk_free_bytes: u64,
    pub memory_available_mb: u64,
    /// Recent 1-minute CPU load fraction, 0.0..=1.0 when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_load: Option<f64>,
    /// Players currently connected, as reported by the game adapter.
    #[serde(default)]
    pub player_count: u32,
    /// True while the user is actively on this machine (affects suitability).
    #[serde(default)]
    pub user_active: bool,
    /// Running on battery power; deprioritized for hosting.
    #[serde(default)]
    pub on_battery: bool,
}

/// Control plane -> agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CpToAgent {
    /// Answer to `Hello`; carries group peers and any current directive.
    Welcome {
        protocol_version: u32,
        room_id: RoomId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lease: Option<Lease>,
    },
    /// Grant or renew a lease. Renewals keep the same epoch.
    Lease(Lease),
    /// Revoke: a newer epoch exists. Any holder must stop immediately.
    Fence {
        server_id: ServerId,
        new_epoch: Epoch,
        reason: String,
    },
    /// Desired run state for a server this node might host.
    SetDesired {
        server_id: ServerId,
        desired: ServerDesired,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        restore: Option<SnapshotId>,
    },
    /// The current authoritative world version, for pre-flight checks.
    WorldVersion {
        server_id: ServerId,
        epoch: Epoch,
        snapshot_id: SnapshotId,
        manifest_url: String,
    },
    /// Tell peers about each other so the mesh can connect.
    SetPeers { peers: Vec<crate::node::PeerView> },
    /// Non-fatal notice to display to the user.
    Notice { level: NoticeLevel, message: String },
}

/// Severity for user-facing notices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::NodeId;

    #[test]
    fn messages_are_tagged_json() {
        let msg = AgentToCp::ReleaseHost {
            node_id: NodeId::generate(),
            server_id: crate::ids::ServerId::generate(),
            epoch: Epoch::new(4),
            reason: "user_quit".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "release_host");
        let back: AgentToCp = serde_json::from_value(json).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn fence_roundtrips() {
        let msg = CpToAgent::Fence {
            server_id: crate::ids::ServerId::generate(),
            new_epoch: Epoch::new(9),
            reason: "epoch_superseded".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: CpToAgent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, msg);
    }
}
