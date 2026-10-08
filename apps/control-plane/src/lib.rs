//! Control plane internals.
//!
//! The control plane is the only component that decides who hosts. It holds no
//! game logic and moves no game bytes: it tracks rooms, hands out time-bounded
//! leases, and records which snapshots are safe.
//!
//! The decision-making core lives in `engine` and is deliberately free of I/O so
//! that its invariants can be tested exhaustively. `api` is the thin HTTP shell
//! around it.

pub mod api;
pub mod engine;
pub mod persist;
pub mod scheduler;

pub use api::{router, AppState};
pub use engine::{Clock, Engine, EngineError, FixedClock, SystemClock, Tick};
pub use persist::{EngineState, StateFile};
pub use scheduler::{place, NodeView, Placement};
