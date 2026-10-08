//! The lease engine: who hosts, and when a lease lapses.
//!
//! This module contains the safety-critical rules and nothing else. It performs no
//! I/O and reads the clock through a trait, so every timing scenario in this file
//! is a deterministic unit test.
//!
//! The invariants it upholds:
//!
//! * **I1 — at most one host.** A new host is only granted after the previous
//!   lease is released or has expired.
//! * **I2 — no lease, no hosting.** An agent whose lease lapses must stop; the
//!   engine never renews an expired lease.
//! * **I3 — epochs never go backwards.** Every handover increments the epoch, and
//!   reports stamped with an older epoch are rejected.

use std::collections::HashMap;

use nomad_proto::epoch::Epoch;
use nomad_proto::ids::{NodeId, ServerId, SnapshotId};
use nomad_proto::room::{Lease, LeaseRole};

use crate::scheduler::{place_with_preference, NodeView};

/// Default lease length. Long enough to survive a hiccup, short enough that a
/// crashed host is replaced quickly.
pub const DEFAULT_LEASE_MS: i64 = 10_000;
/// Renewals should arrive well inside the lease window.
pub const RENEW_INTERVAL_MS: i64 = 3_000;

/// A source of wall-clock time, in Unix milliseconds.
pub trait Clock: Send + Sync {
    fn now_unix_ms(&self) -> i64;
}

/// Reads the real clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

/// A clock the tests drive by hand.
#[derive(Debug, Default, Clone)]
pub struct FixedClock(std::sync::Arc<std::sync::atomic::AtomicI64>);

impl FixedClock {
    pub fn new(start_ms: i64) -> Self {
        Self(std::sync::Arc::new(std::sync::atomic::AtomicI64::new(
            start_ms,
        )))
    }

    /// Advance the clock, simulating the passage of time.
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Clock for FixedClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Why a request was refused.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EngineError {
    #[error("this node is not known to the room")]
    UnknownNode,
    #[error("this node is not online")]
    NotOnline,
    #[error("this node has hosting disabled")]
    HostingDisabled,
    #[error("another host holds a live lease (epoch {held})")]
    HostBusy { held: u64 },
    #[error("no eligible host is available")]
    NoCandidate,
    #[error("epoch {got} is stale (current {current})")]
    StaleEpoch { got: u64, current: u64 },
    #[error("snapshot {0} is not known to this room")]
    UnknownSnapshot(String),
}

/// The result of advancing the engine to the current time.
#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    /// Servers whose lease lapsed and now need a new host.
    pub expired: Vec<ServerId>,
    /// Nodes whose lease was revoked and that must stop serving.
    pub fenced: Vec<NodeId>,
}

/// One server's live state inside the engine.
#[derive(Debug, Clone)]
struct ServerRecord {
    epoch: Epoch,
    lease: Option<Lease>,
    /// Highest snapshot the room considers safe to restore from.
    committed: Option<SnapshotId>,
}

/// A node's live state inside the engine.
#[derive(Debug, Clone)]
struct NodeRecord {
    view: NodeView,
    public_key: String,
}

/// Decides who hosts. Holds all room state in memory; a durable store can be
/// layered on top without changing these rules.
pub struct Engine<C: Clock> {
    clock: C,
    lease_ms: i64,
    servers: HashMap<ServerId, ServerRecord>,
    nodes: HashMap<NodeId, NodeRecord>,
}

impl<C: Clock> Engine<C> {
    /// Create an engine with the default lease length.
    pub fn new(clock: C) -> Self {
        Self::with_lease_ms(clock, DEFAULT_LEASE_MS)
    }

    /// Create an engine with an explicit lease length.
    pub fn with_lease_ms(clock: C, lease_ms: i64) -> Self {
        Self {
            clock,
            lease_ms,
            servers: HashMap::new(),
            nodes: HashMap::new(),
        }
    }

    /// Register or replace a node's facts.
    pub fn upsert_node(&mut self, view: NodeView, public_key: impl Into<String>) {
        let public_key = public_key.into();
        self.nodes
            .insert(view.node_id.clone(), NodeRecord { view, public_key });
    }

    /// Mark a node offline. Its lease, if any, is revoked on the next tick.
    pub fn set_node_online(&mut self, node_id: &NodeId, online: bool) {
        if let Some(rec) = self.nodes.get_mut(node_id) {
            rec.view.online = online;
        }
    }

    /// Ensure a server record exists, starting at epoch 0 (never hosted).
    pub fn ensure_server(&mut self, server_id: &ServerId) {
        self.servers
            .entry(server_id.clone())
            .or_insert(ServerRecord {
                epoch: Epoch::ZERO,
                lease: None,
                committed: None,
            });
    }

    /// Snapshot ids are only restorable once recorded as committed here.
    pub fn record_committed(
        &mut self,
        server_id: &ServerId,
        snapshot: SnapshotId,
    ) -> Result<(), EngineError> {
        let rec = self
            .servers
            .get_mut(server_id)
            .ok_or(EngineError::UnknownSnapshot(snapshot.as_str().to_string()))?;
        rec.committed = Some(snapshot);
        Ok(())
    }

    /// The current epoch for a server (0 when never hosted).
    pub fn epoch(&self, server_id: &ServerId) -> Epoch {
        self.servers
            .get(server_id)
            .map(|s| s.epoch)
            .unwrap_or(Epoch::ZERO)
    }

    /// The current lease, if it has not expired.
    pub fn active_lease(&self, server_id: &ServerId) -> Option<&Lease> {
        let now = self.clock.now_unix_ms();
        self.servers
            .get(server_id)
            .and_then(|s| s.lease.as_ref())
            .filter(|l| l.expires_at_unix_ms > now)
    }

    /// The committed snapshot for a server, if any.
    pub fn committed_snapshot(&self, server_id: &ServerId) -> Option<&SnapshotId> {
        self.servers
            .get(server_id)
            .and_then(|s| s.committed.as_ref())
    }

    /// A view of every node, for the scheduler.
    fn node_views(&self) -> Vec<NodeView> {
        self.nodes.values().map(|n| n.view.clone()).collect()
    }

    /// Renew the current host's lease. Fails if it is not the holder or the lease
    /// already lapsed (I2 — an expired lease can never be revived).
    pub fn renew(
        &mut self,
        server_id: &ServerId,
        node_id: &NodeId,
        epoch: Epoch,
    ) -> Result<Lease, EngineError> {
        let now = self.clock.now_unix_ms();
        let lease_ms = self.lease_ms;
        let rec = self
            .servers
            .get_mut(server_id)
            .ok_or(EngineError::NoCandidate)?;

        match &mut rec.lease {
            Some(l) if l.node_id == *node_id && l.epoch == epoch && l.expires_at_unix_ms > now => {
                l.expires_at_unix_ms = now + lease_ms;
                Ok(l.clone())
            }
            Some(l) if l.expires_at_unix_ms > now => Err(EngineError::HostBusy {
                held: l.epoch.get(),
            }),
            _ => {
                // Either no lease, or one that already lapsed: force an election
                // rather than silently reviving a dead host.
                Err(EngineError::StaleEpoch {
                    got: epoch.get(),
                    current: rec.epoch.get(),
                })
            }
        }
    }

    /// Grant hosting, electing a node when none is specified.
    ///
    /// Refuses when a live lease exists (I1). On success the epoch is bumped and
    /// the new host is told which snapshot to restore.
    pub fn claim(
        &mut self,
        server_id: &ServerId,
        requested: Option<&NodeId>,
    ) -> Result<Lease, EngineError> {
        self.ensure_server(server_id);
        let now = self.clock.now_unix_ms();
        let lease_ms = self.lease_ms;

        // I1: refuse while someone holds a live lease.
        {
            let rec = self.servers.get(server_id).expect("ensured above");
            if let Some(l) = &rec.lease {
                if l.expires_at_unix_ms > now {
                    return Err(EngineError::HostBusy {
                        held: l.epoch.get(),
                    });
                }
            }
        }

        // If a specific node was requested, validate it explicitly so the caller
        // gets a precise error instead of a generic "no candidate".
        if let Some(want) = requested {
            let rec = self.nodes.get(want).ok_or(EngineError::UnknownNode)?;
            if !rec.view.online {
                return Err(EngineError::NotOnline);
            }
            if !rec.view.hosting_enabled {
                return Err(EngineError::HostingDisabled);
            }
        }

        let views = self.node_views();
        let pick = place_with_preference(&views, requested).ok_or(EngineError::NoCandidate)?;

        let rec = self.servers.get_mut(server_id).expect("ensured above");
        rec.epoch = rec.epoch.next();
        let lease = Lease {
            server_id: server_id.clone(),
            room_id: nomad_proto::ids::RoomId::generate(),
            node_id: pick.node_id,
            role: LeaseRole::Host,
            epoch: rec.epoch,
            expires_at_unix_ms: now + lease_ms,
            restore_snapshot: rec.committed.clone(),
        };
        rec.lease = Some(lease.clone());
        Ok(lease)
    }

    /// Voluntarily give up hosting.
    ///
    /// Clears the lease so the next claim elects immediately instead of waiting for
    /// it to expire, and marks the departing node as draining so the scheduler does
    /// not hand hosting straight back to the machine that just quit (which would be
    /// a pointless flurry of handovers while its user is trying to leave).
    pub fn release(
        &mut self,
        server_id: &ServerId,
        node_id: &NodeId,
        epoch: Epoch,
    ) -> Result<(), EngineError> {
        let rec = self
            .servers
            .get_mut(server_id)
            .ok_or(EngineError::NoCandidate)?;
        if rec.epoch != epoch {
            return Err(EngineError::StaleEpoch {
                got: epoch.get(),
                current: rec.epoch.get(),
            });
        }
        // Only the current holder may release.
        match &rec.lease {
            Some(l) if l.node_id == *node_id => {}
            Some(l) => {
                return Err(EngineError::StaleEpoch {
                    got: epoch.get(),
                    current: l.epoch.get(),
                })
            }
            None => return Ok(()), // already free; releasing is idempotent
        }
        rec.lease = None;
        if let Some(n) = self.nodes.get_mut(node_id) {
            n.view.draining = true;
        }
        Ok(())
    }

    /// Clear a node's draining flag, e.g. when its user starts playing again.
    pub fn clear_draining(&mut self, node_id: &NodeId) {
        if let Some(n) = self.nodes.get_mut(node_id) {
            n.view.draining = false;
        }
    }

    /// The pinned public key for a node, used when authenticating peers.
    pub fn public_key(&self, node_id: &NodeId) -> Option<&str> {
        self.nodes.get(node_id).map(|n| n.public_key.as_str())
    }

    /// Verify that a report from an agent is stamped with the current epoch (I3).
    pub fn check_epoch(&self, server_id: &ServerId, epoch: Epoch) -> Result<(), EngineError> {
        let current = self.epoch(server_id);
        if epoch == current && current.get() > 0 {
            Ok(())
        } else {
            Err(EngineError::StaleEpoch {
                got: epoch.get(),
                current: current.get(),
            })
        }
    }

    /// Advance time: expire lapsed leases and report what changed.
    ///
    /// Expiring a lease bumps nothing on its own; the next `claim` does. It does
    /// fence the old node, so the caller must tell that agent to stop.
    pub fn tick(&mut self) -> Tick {
        let now = self.clock.now_unix_ms();
        let mut expired = Vec::new();
        let mut fenced = Vec::new();

        for (server_id, rec) in self.servers.iter_mut() {
            if let Some(l) = rec.lease.clone() {
                let node_offline = self
                    .nodes
                    .get(&l.node_id)
                    .map(|n| !n.view.online)
                    .unwrap_or(true);
                if l.expires_at_unix_ms <= now || node_offline {
                    rec.lease = None;
                    expired.push(server_id.clone());
                    // A node that lost its lease must stop serving.
                    fenced.push(l.node_id.clone());
                }
            }
        }

        Tick { expired, fenced }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nv(id: &str, cores: u32) -> NodeView {
        NodeView {
            node_id: NodeId::from_raw(id),
            online: true,
            hosting_enabled: true,
            anchor: false,
            priority: 0,
            cpu_cores: cores,
            memory_mb: 8192,
            disk_free_bytes: 50 * 1024 * 1024 * 1024,
            uplink_mbps: 20.0,
            user_active: false,
            on_battery: false,
            has_current_snapshot: false,
            uptime_s: 600,
            players_here: 0,
            restore_bytes: 0,
            draining: false,
        }
    }

    fn engine() -> (Engine<FixedClock>, ServerId) {
        let mut e = Engine::new(FixedClock::new(1_000_000));
        e.upsert_node(nv("node_a", 4), "pk_a");
        e.upsert_node(nv("node_b", 16), "pk_b");
        let srv = ServerId::generate();
        e.ensure_server(&srv);
        (e, srv)
    }

    #[test]
    fn first_claim_elects_strongest_node_at_epoch_one() {
        let (mut e, srv) = engine();
        let lease = e.claim(&srv, None).unwrap();
        assert_eq!(lease.node_id.as_str(), "node_b"); // 16 cores beats 4
        assert_eq!(lease.epoch.get(), 1);
        assert!(lease.is_active());
    }

    #[test]
    fn second_claim_is_refused_while_lease_is_live() {
        let (mut e, srv) = engine();
        e.claim(&srv, None).unwrap();
        let err = e.claim(&srv, None).unwrap_err();
        assert!(matches!(err, EngineError::HostBusy { held: 1 }));
    }

    #[test]
    fn claim_after_expiry_increments_epoch() {
        let (mut e, srv) = engine();
        let first = e.claim(&srv, None).unwrap();
        e.clock.advance(DEFAULT_LEASE_MS + 1);

        let tick = e.tick();
        assert_eq!(tick.expired, vec![srv.clone()]);
        assert_eq!(tick.fenced, vec![first.node_id.clone()]);

        let second = e.claim(&srv, None).unwrap();
        assert_eq!(second.epoch.get(), first.epoch.get() + 1);
        assert!(second.epoch.is_newer_than(first.epoch));
    }

    #[test]
    fn expired_lease_can_never_be_renewed() {
        let (mut e, srv) = engine();
        let lease = e.claim(&srv, None).unwrap();
        e.clock.advance(DEFAULT_LEASE_MS + 1);
        let err = e.renew(&srv, &lease.node_id, lease.epoch).unwrap_err();
        assert!(matches!(err, EngineError::StaleEpoch { .. }));
    }

    #[test]
    fn renewal_extends_within_the_same_epoch() {
        let (mut e, srv) = engine();
        let lease = e.claim(&srv, None).unwrap();
        e.clock.advance(1_000);
        let renewed = e.renew(&srv, &lease.node_id, lease.epoch).unwrap();
        assert_eq!(renewed.epoch, lease.epoch);
        assert!(renewed.expires_at_unix_ms > lease.expires_at_unix_ms);
    }

    #[test]
    fn release_hands_over_to_a_different_node_immediately() {
        let (mut e, srv) = engine();
        let first = e.claim(&srv, None).unwrap();
        assert_eq!(first.node_id.as_str(), "node_b");
        e.release(&srv, &first.node_id, first.epoch).unwrap();

        // The node that just quit is draining, so the next election must pick the
        // other machine even though the quitter is stronger.
        let second = e.claim(&srv, None).unwrap();
        assert_eq!(second.epoch.get(), 2);
        assert_ne!(second.node_id, first.node_id);
        assert_eq!(second.node_id.as_str(), "node_a");
    }

    #[test]
    fn draining_clears_when_the_user_returns() {
        let (mut e, srv) = engine();
        let first = e.claim(&srv, None).unwrap();
        e.release(&srv, &first.node_id, first.epoch).unwrap();
        // Second host is node_a; let it leave too, then node_b comes back.
        let second = e.claim(&srv, None).unwrap();
        e.release(&srv, &second.node_id, second.epoch).unwrap();

        // Now everyone is draining: nobody can host.
        assert_eq!(e.claim(&srv, None).unwrap_err(), EngineError::NoCandidate);

        // node_b's user rejoins: clear draining and it becomes eligible again.
        e.clear_draining(&first.node_id);
        let third = e.claim(&srv, None).unwrap();
        assert_eq!(third.node_id, first.node_id);
        assert_eq!(third.epoch.get(), 3);
    }

    #[test]
    fn release_by_a_non_holder_is_rejected() {
        let (mut e, srv) = engine();
        let lease = e.claim(&srv, None).unwrap();
        // node_a is not the host; it must not be able to release node_b's lease.
        let err = e
            .release(&srv, &NodeId::from_raw("node_a"), lease.epoch)
            .unwrap_err();
        assert!(matches!(err, EngineError::StaleEpoch { .. }));
        // The real host still holds its lease.
        assert!(e.active_lease(&srv).is_some());
    }

    #[test]
    fn offline_host_is_fenced_on_tick() {
        let (mut e, srv) = engine();
        let lease = e.claim(&srv, None).unwrap();
        e.set_node_online(&lease.node_id, false);
        let tick = e.tick();
        assert!(tick.fenced.contains(&lease.node_id));
        assert!(e.active_lease(&srv).is_none());
    }

    #[test]
    fn stale_epoch_reports_are_rejected() {
        let (mut e, srv) = engine();
        let first = e.claim(&srv, None).unwrap();
        e.release(&srv, &first.node_id, first.epoch).unwrap();
        let second = e.claim(&srv, None).unwrap();

        assert!(e.check_epoch(&srv, second.epoch).is_ok());
        let err = e.check_epoch(&srv, first.epoch).unwrap_err();
        assert!(matches!(err, EngineError::StaleEpoch { .. }));
    }

    #[test]
    fn requested_host_must_be_online_and_enabled() {
        let (mut e, srv) = engine();
        e.set_node_online(&NodeId::from_raw("node_a"), false);
        let err = e
            .claim(&srv, Some(&NodeId::from_raw("node_a")))
            .unwrap_err();
        assert_eq!(err, EngineError::NotOnline);

        let err = e
            .claim(&srv, Some(&NodeId::from_raw("node_ghost")))
            .unwrap_err();
        assert_eq!(err, EngineError::UnknownNode);
    }

    #[test]
    fn claim_carries_committed_snapshot_for_restore() {
        let (mut e, srv) = engine();
        let snap = SnapshotId::from_raw("snap_abc");
        e.record_committed(&srv, snap.clone()).unwrap();
        let lease = e.claim(&srv, None).unwrap();
        assert_eq!(lease.restore_snapshot, Some(snap));
    }

    #[test]
    fn no_eligible_node_reports_cleanly() {
        let mut e = Engine::new(FixedClock::new(0));
        e.upsert_node(nv("node_a", 4), "pk");
        e.set_node_online(&NodeId::from_raw("node_a"), false);
        let srv = ServerId::generate();
        e.ensure_server(&srv);
        let err = e.claim(&srv, None).unwrap_err();
        assert_eq!(err, EngineError::NoCandidate);
    }
}
