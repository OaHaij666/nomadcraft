//! The NomadCraft agent library.
//!
//! The agent is the only component that touches the game. It runs on every
//! player's machine and does four things:
//!
//! 1. **Talk to the control plane** — register, heartbeat, claim or release a
//!    lease. The agent never decides who hosts; it asks and obeys.
//! 2. **Supervise the server process** — start, watch, and gracefully stop the
//!    local Minecraft server so its world is always saved cleanly.
//! 3. **Guard the world** — take a consistent checkpoint before a handover and
//!    restore one before starting.
//! 4. **Hold a tunnel** — keep outbound connections open to the relay so players
//!    can reach this machine without port forwarding.
//!
//! Like the control plane, the interesting logic is separated from I/O so it is
//! testable: [`supervisor`] knows nothing about HTTP or sockets.

pub mod config;
pub mod control;
pub mod supervisor;

pub use config::AgentConfig;
pub use control::{ControlClient, ControlError};
pub use supervisor::{ServerSpec, ServerState, StopAction, StopPolicy, Supervisor};
