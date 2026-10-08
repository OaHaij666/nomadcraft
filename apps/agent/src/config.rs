//! Agent configuration.

use std::path::PathBuf;

/// Everything the agent needs to run.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Base URL of the control plane, e.g. `http://127.0.0.1:8787`.
    pub control_plane: String,
    /// Directory holding agent state (world, snapshots, identity).
    pub data_dir: PathBuf,
    /// Directory for the live server (holds `world/`, `server.jar`).
    pub server_dir: PathBuf,
    /// Heap size to request from Java, in MB.
    pub heap_mb: u32,
    /// How often to take and push a checkpoint while hosting.
    pub checkpoint_every: std::time::Duration,
    /// Whether this machine may be elected host.
    pub hosting_enabled: bool,
    /// Whether this machine is an always-on replica.
    pub anchor: bool,
}

impl AgentConfig {
    /// Sensible defaults for a Windows gaming PC.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            control_plane: "http://127.0.0.1:8787".into(),
            server_dir: data_dir.join("server"),
            data_dir,
            heap_mb: 4096,
            checkpoint_every: std::time::Duration::from_secs(120),
            hosting_enabled: true,
            anchor: false,
        }
    }

    /// Directory where snapshots are cached.
    pub fn store_dir(&self) -> PathBuf {
        self.data_dir.join("store")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_self_consistent() {
        let c = AgentConfig::new("/data/nomad");
        assert!(c.hosting_enabled);
        assert!(c.heap_mb >= 1024);
        assert_eq!(c.store_dir(), std::path::PathBuf::from("/data/nomad/store"));
    }
}
