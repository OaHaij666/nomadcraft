//! Monotonic execution epochs — the fencing token that prevents split brain.
//!
//! Every time hosting moves to a different machine, the room's epoch increases by
//! one. Writes to the world are stamped with the epoch they were produced under,
//! and the control plane rejects anything older than the current epoch. A host
//! that discovers a newer epoch exists must stop immediately ("self-fence"):
//! serving a stale world is always worse than briefly serving none.

use serde::{Deserialize, Serialize};

/// A monotonically increasing execution counter for one logical server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(u64);

impl Epoch {
    /// The epoch before any host has ever run.
    pub const ZERO: Epoch = Epoch(0);

    pub const fn new(raw: u64) -> Self {
        Self(raw)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    /// The next epoch, used when handing hosting to another machine.
    pub const fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// Returns an error when `self` is not newer than `current`.
    pub fn ensure_newer_than(self, current: Epoch) -> crate::Result<()> {
        if self.0 <= current.0 {
            return Err(crate::ProtoError::StaleEpoch {
                got: self.0,
                current: current.0,
            });
        }
        Ok(())
    }

    /// True when `self` is strictly newer than `other`.
    pub const fn is_newer_than(self, other: Epoch) -> bool {
        self.0 > other.0
    }
}

impl std::fmt::Display for Epoch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<u64> for Epoch {
    fn from(v: u64) -> Self {
        Self(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_increments() {
        assert_eq!(Epoch::ZERO.next().get(), 1);
        assert_eq!(Epoch::new(41).next().get(), 42);
    }

    #[test]
    fn stale_epoch_is_rejected() {
        assert!(Epoch::new(7).ensure_newer_than(Epoch::new(7)).is_err());
        assert!(Epoch::new(6).ensure_newer_than(Epoch::new(7)).is_err());
        assert!(Epoch::new(8).ensure_newer_than(Epoch::new(7)).is_ok());
    }

    #[test]
    fn ordering_is_monotonic() {
        assert!(Epoch::new(2).is_newer_than(Epoch::new(1)));
        assert!(!Epoch::new(1).is_newer_than(Epoch::new(2)));
    }
}
