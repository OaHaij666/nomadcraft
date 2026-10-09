//! Persisting the engine so a control-plane restart does not forget who hosts.
//!
//! The engine's whole state is small (rooms, nodes, leases, epochs) and is written
//! as one JSON document via a temp file and an atomic rename. Losing it is
//! recoverable — leases simply expire and a new election happens — but keeping it
//! avoids a needless handover on every deploy.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use nomad_proto::ids::{NodeId, RoomId, ServerId};
use serde::{Deserialize, Serialize};

use crate::engine::{Clock, Engine, NodeRecord, RoomRecord, ServerRecord};

/// A serializable copy of everything the engine knows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineState {
    pub servers: HashMap<ServerId, ServerRecord>,
    pub nodes: HashMap<NodeId, NodeRecord>,
    /// Room membership, so the door survives a control-plane restart.
    #[serde(default)]
    pub rooms: HashMap<RoomId, RoomRecord>,
}

/// Load, mutate, and atomically persist engine state.
pub struct StateFile {
    path: PathBuf,
}

impl StateFile {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the saved state, or an empty one when the file does not exist yet.
    pub fn load(&self) -> anyhow::Result<EngineState> {
        if !self.path.exists() {
            return Ok(EngineState::default());
        }
        let bytes = std::fs::read(&self.path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Replace the file atomically.
    pub fn save(&self, state: &EngineState) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(state)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

impl<C: Clock> Engine<C> {
    /// Export a serializable copy of all state.
    pub fn export(&self) -> EngineState {
        EngineState {
            servers: self.servers_snapshot(),
            nodes: self.nodes_snapshot(),
            rooms: self.rooms_snapshot(),
        }
    }

    /// Replace all state from a previously exported copy.
    pub fn import(&mut self, state: EngineState) {
        self.set_state(state.servers, state.nodes, state.rooms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{FixedClock, SystemClock};

    #[test]
    fn roundtrips_engine_state_through_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = StateFile::new(tmp.path().join("engine.json"));

        let mut engine = Engine::new(FixedClock::new(0));
        let room = nomad_proto::ids::RoomId::generate();
        let srv = ServerId::generate();
        let node = NodeId::from_raw("node_a");
        engine.ensure_server(&srv, &room);
        engine.upsert_node(
            crate::scheduler::NodeView {
                node_id: node.clone(),
                online: true,
                hosting_enabled: true,
                anchor: true,
                priority: 5,
                cpu_cores: 8,
                memory_mb: 16384,
                disk_free_bytes: 1,
                uplink_mbps: 50.0,
                user_active: false,
                on_battery: false,
                has_current_snapshot: false,
                uptime_s: 100,
                players_here: 0,
                restore_bytes: 0,
                draining: false,
            },
            "pk_a",
        );
        let lease = engine.claim(&srv, None).unwrap();

        file.save(&engine.export()).unwrap();

        let loaded = file.load().unwrap();
        let mut restored = Engine::<SystemClock>::new(SystemClock);
        restored.import(loaded);

        assert_eq!(restored.epoch(&srv), lease.epoch);
        assert_eq!(restored.room_of(&srv).unwrap(), &room);
        assert_eq!(restored.public_key(&node), Some("pk_a"));
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let file = StateFile::new(tmp.path().join("nope.json"));
        let state = file.load().unwrap();
        assert!(state.servers.is_empty());
        assert!(state.nodes.is_empty());
    }
}
