//! Rooms, servers, and the lease that grants hosting.

use serde::{Deserialize, Serialize};

use crate::epoch::Epoch;
use crate::ids::{NodeId, RoomId, ServerId, SnapshotId};

/// What the room owner wants to happen to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerDesired {
    /// Someone wants to play; converge toward a running host.
    Running,
    /// Sleep until the next player arrives.
    Stopped,
}

/// Overall lifecycle of a room, useful for the dashboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomState {
    /// No players; world asleep, nothing running.
    Sleeping,
    /// A host is preparing (downloading world, starting the server).
    Waking,
    /// A host is live and accepting players.
    Live,
    /// Hosting is moving from one machine to another.
    HandingOver,
}

/// Which role a lease grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseRole {
    /// Run the game and serve players. Exactly one of these per server.
    Host,
    /// Hold the latest save so it outlives any single machine.
    Anchor,
    /// Be ready to host; may pre-download but must not serve.
    Standby,
}

/// A time-bounded grant to act in a role.
///
/// The epoch is the fencing token: once the control plane moves past it, any
/// holder must stop. Agents compute a conservative local deadline so a network
/// partition can never produce two simultaneous hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub server_id: ServerId,
    pub room_id: RoomId,
    pub node_id: NodeId,
    pub role: LeaseRole,
    pub epoch: Epoch,
    /// Absolute Unix-ms instant after which the lease is void.
    pub expires_at_unix_ms: i64,
    /// World state the holder should restore before serving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_snapshot: Option<SnapshotId>,
}

impl Lease {
    /// A lease is only meaningful with a non-zero epoch.
    pub fn is_active(&self) -> bool {
        self.epoch.get() > 0
    }
}
