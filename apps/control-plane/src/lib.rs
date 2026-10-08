//! Control plane internals.
//!
//! The control plane is the only component that decides who hosts. It holds no
//! game logic and moves no game bytes: it tracks rooms, hands out time-bounded
//! leases, and records which snapshots are safe.
//!
//! The decision-making core lives in `engine` and is deliberately free of I/O so
//! that its invariants can be tested exhaustively.

pub mod engine;
pub mod scheduler;

pub use engine::{Clock, Engine, EngineError, FixedClock, SystemClock, Tick};
pub use scheduler::{place, NodeView, Placement};
