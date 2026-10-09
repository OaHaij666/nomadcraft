//! Shared types for NomadCraft.
//!
//! NomadCraft hosts a Minecraft world across a group of friends' machines. At any
//! moment exactly one machine is the *active host* and runs the real server; a
//! lightweight control plane hands out time-bounded *leases* so that another
//! machine can take over when the host leaves.
//!
//! This crate is the vocabulary every component agrees on. It contains no I/O.

pub mod door;
pub mod epoch;
pub mod ids;
pub mod manifest;
pub mod message;
pub mod node;
pub mod room;

pub use door::{sign_ticket, ticket_bytes, ticket_is_fresh, verify_ticket, DoorTicket};
pub use epoch::Epoch;
pub use ids::{NodeId, RoomId, ServerId, SnapshotId};
pub use manifest::{FileEntry, FileKind, Manifest, PathPattern};
pub use message::{AgentToCp, CpToAgent};
pub use node::{NodeCapabilities, NodeState};
pub use room::{Lease, LeaseRole, RoomState, ServerDesired};

/// Protocol version for the control-plane <-> agent wire format.
pub const PROTOCOL_VERSION: u32 = 1;

/// Re-export the result alias used throughout the workspace.
pub type Result<T> = std::result::Result<T, ProtoError>;

#[derive(Debug, thiserror::Error)]
pub enum ProtoError {
    #[error("invalid identifier: {0}")]
    InvalidId(String),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("path is not allowed: {0}")]
    UnsafePath(String),
    #[error("epoch {got} is older than current {current}")]
    StaleEpoch { got: u64, current: u64 },
    #[error("manifest does not match its digest")]
    ManifestDigestMismatch,
}
