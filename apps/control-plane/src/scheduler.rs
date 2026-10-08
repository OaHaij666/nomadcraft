//! Deterministic host placement.
//!
//! Given the same inputs this function always returns the same answer, with ties
//! broken by node id. Determinism matters: it makes elections reproducible and
//! debuggable, and it means two control-plane replicas would agree.

use nomad_proto::ids::NodeId;

/// A candidate machine, as far as placement cares.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NodeView {
    pub node_id: NodeId,
    /// Reachable right now.
    pub online: bool,
    /// Opted in as a possible host by its owner.
    pub hosting_enabled: bool,
    /// Always-on replica (NAS, VPS). Preferred for staying power, never forced.
    pub anchor: bool,
    /// Operator priority, higher wins.
    pub priority: i32,
    pub cpu_cores: u32,
    pub memory_mb: u64,
    pub disk_free_bytes: u64,
    pub uplink_mbps: f64,
    /// The user is actively using this machine, so hosting would hurt them.
    pub user_active: bool,
    /// Running on battery; deprioritized.
    pub on_battery: bool,
    /// Already has the current world locally (avoids a big download).
    pub has_current_snapshot: bool,
    /// Seconds since this node came online.
    pub uptime_s: i64,
    /// Players already connected to this node, if it happens to be hosting.
    pub players_here: u32,
    /// Estimated bytes it must download before serving.
    pub restore_bytes: u64,
    /// The machine is on its way out (user quitting); do not elect it now.
    pub draining: bool,
}

/// The chosen host along with an explanation for the dashboard.
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub node_id: NodeId,
    pub score: f64,
    pub reasons: Vec<String>,
}

/// Score a single node. Higher is better. Pure math, no I/O.
fn score(n: &NodeView) -> f64 {
    let mut s = 0.0;

    // Staying power: an anchor or a long-lived machine is less likely to vanish.
    if n.anchor {
        s += 40.0;
    }
    s += (n.uptime_s as f64 / 60.0).min(60.0);

    // Capacity.
    s += (n.cpu_cores as f64 * 3.0).min(30.0);
    s += ((n.memory_mb as f64) / 1024.0).min(32.0);
    s += (n.uplink_mbps / 2.0).min(40.0);

    // Already has the world: avoids a download and a long handover.
    if n.has_current_snapshot {
        s += 50.0;
    }
    // Penalize a large restore, but keep it bounded so a good host still wins.
    s -= (n.restore_bytes as f64 / (256.0 * 1024.0 * 1024.0)).min(25.0);

    // Operator intent.
    s += n.priority as f64 * 10.0;

    // Don't hurt someone who is using their machine right now.
    if n.user_active {
        s -= 30.0;
    }
    if n.on_battery {
        s -= 25.0;
    }

    // Keep the current host if it's still working: stability beats a tiny gain.
    s += n.players_here as f64 * 5.0;

    s
}

/// Choose a host from the candidate set. `None` when nobody can host.
pub fn place(nodes: &[NodeView]) -> Option<Placement> {
    place_with_preference(nodes, None)
}

/// Choose a host, optionally preferring a specific node (operator or sticky).
pub fn place_with_preference(nodes: &[NodeView], prefer: Option<&NodeId>) -> Option<Placement> {
    let mut eligible: Vec<&NodeView> = nodes
        .iter()
        .filter(|n| n.online && n.hosting_enabled && !n.draining)
        .collect();
    if eligible.is_empty() {
        return None;
    }

    // Stable ordering: by node id, so equal scores resolve identically.
    eligible.sort_by(|a, b| a.node_id.cmp(&b.node_id));

    let mut scored: Vec<(f64, &NodeView, bool)> = eligible
        .iter()
        .map(|n| {
            let is_preferred = prefer.map(|p| p == &n.node_id).unwrap_or(false);
            let mut s = score(n);
            if is_preferred {
                s += 100.0;
            }
            (s, *n, is_preferred)
        })
        .collect();

    // Highest score wins; ties keep node-id order from the sort above.
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.node_id.cmp(&b.1.node_id))
    });

    let (best_score, best, preferred) = scored.first()?;
    let mut reasons = Vec::new();
    if *preferred {
        reasons.push("operator-preferred".to_string());
    }
    if best.anchor {
        reasons.push("always-on replica".to_string());
    }
    if best.has_current_snapshot {
        reasons.push("already has the latest world".to_string());
    }
    reasons.push(format!("{} cpu cores", best.cpu_cores));
    reasons.push(format!("{:.1} Mbps uplink", best.uplink_mbps));
    if best.user_active {
        reasons.push("user is currently active here".to_string());
    }

    Some(Placement {
        node_id: best.node_id.clone(),
        score: *best_score,
        reasons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> NodeView {
        NodeView {
            node_id: NodeId::from_raw(id),
            online: true,
            hosting_enabled: true,
            anchor: false,
            priority: 0,
            cpu_cores: 4,
            memory_mb: 8192,
            disk_free_bytes: 20 * 1024 * 1024 * 1024,
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

    #[test]
    fn no_eligible_nodes_yields_none() {
        assert!(place(&[]).is_none());
        let mut offline = node("node_a");
        offline.online = false;
        assert!(place(&[offline]).is_none());
    }

    #[test]
    fn stronger_machine_wins() {
        let weak = node("node_a");
        let mut strong = node("node_b");
        strong.cpu_cores = 16;
        strong.memory_mb = 32 * 1024;
        strong.uplink_mbps = 100.0;
        let pick = place(&[weak, strong]).unwrap();
        assert_eq!(pick.node_id.as_str(), "node_b");
    }

    #[test]
    fn preferring_the_current_host_keeps_it() {
        let a = node("node_a");
        let mut b = node("node_b");
        b.cpu_cores = 8;
        // b is stronger, but a is preferred (it is already hosting).
        let pick = place_with_preference(&[a.clone(), b], Some(&a.node_id)).unwrap();
        assert_eq!(pick.node_id.as_str(), "node_a");
    }

    #[test]
    fn ties_break_on_node_id_deterministically() {
        let a = node("node_a");
        let b = node("node_b");
        let pick = place(&[b.clone(), a.clone()]).unwrap();
        let pick2 = place(&[a, b]).unwrap();
        assert_eq!(pick.node_id, pick2.node_id);
        assert_eq!(pick.node_id.as_str(), "node_a");
    }

    #[test]
    fn user_active_is_deprioritized() {
        let mut busy = node("node_a");
        busy.cpu_cores = 16;
        busy.user_active = true;
        let idle = node("node_b");
        let pick = place(&[busy, idle]).unwrap();
        assert_eq!(pick.node_id.as_str(), "node_b");
    }

    #[test]
    fn draining_node_is_not_elected() {
        let mut leaving = node("node_a");
        leaving.cpu_cores = 16;
        leaving.draining = true;
        let staying = node("node_b");
        let pick = place(&[leaving, staying]).unwrap();
        assert_eq!(pick.node_id.as_str(), "node_b");
    }

    #[test]
    fn all_nodes_draining_yields_none() {
        let mut a = node("node_a");
        a.draining = true;
        let mut b = node("node_b");
        b.draining = true;
        assert!(place(&[a, b]).is_none());
    }

    #[test]
    fn having_the_world_beats_a_slightly_stronger_machine() {
        let mut holder = node("node_a");
        holder.has_current_snapshot = true;
        let mut stronger = node("node_b");
        stronger.cpu_cores = 8;
        let pick = place(&[holder, stronger]).unwrap();
        assert_eq!(pick.node_id.as_str(), "node_a");
    }
}
