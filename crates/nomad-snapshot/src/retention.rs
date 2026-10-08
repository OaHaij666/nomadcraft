//! Snapshot retention: how many versions we keep, and why.
//!
//! Rolling back is only possible if old snapshots still exist. Retention decides
//! which ones to keep so that "a recent good state" is always available without
//! hoarding every checkpoint forever.
//!
//! Two ideas work together:
//!
//! * **A protected floor.** The newest snapshot is never deleted, and the newest
//!   one of each `reason` (scheduled / manual / final / migration) is kept so a
//!   scheduled checkpoint cannot evict the only final save.
//! * **A time-tiered history.** Beyond the most recent few, we keep progressively
//!   sparser snapshots (like hourly/daily/weekly), so a long session does not
//!   flood the store yet a month-old state is still reachable.

use std::collections::HashMap;

use nomad_proto::ids::SnapshotId;

/// One snapshot as far as retention is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedSnapshot {
    pub id: SnapshotId,
    /// Creation time in Unix milliseconds.
    pub created_at_unix_ms: i64,
    /// `scheduled` | `manual` | `final` | `migration` | anything else.
    pub reason: String,
    /// Pinned snapshots are never deleted (e.g. "this is the known-good state").
    pub pinned: bool,
    /// Total bytes this snapshot occupies (for size-based pruning).
    pub size_bytes: u64,
}

/// The retention policy itself.
#[derive(Debug, Clone)]
pub struct RetentionPolicy {
    /// Always keep at least this many of the newest snapshots.
    pub keep_min: usize,
    /// Keep at most this many snapshots overall (before protection is applied).
    pub keep_max: usize,
    /// Time buckets to preserve beyond `keep_min`: (bucket width in seconds, count).
    /// Defaults to hourly for a day, daily for a fortnight, weekly for a quarter.
    pub tiers: Vec<Tier>,
    /// Optional hard cap on stored bytes; oldest unprotected snapshots go first.
    pub max_total_bytes: Option<u64>,
}

/// One tier of the time-tiered history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tier {
    /// Bucket width in seconds.
    pub every_secs: i64,
    /// How many buckets to keep in this tier.
    pub keep: usize,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            keep_min: 3,
            keep_max: 200,
            tiers: vec![
                Tier {
                    every_secs: 60 * 60,
                    keep: 24,
                }, // hourly, one day
                Tier {
                    every_secs: 24 * 60 * 60,
                    keep: 14,
                }, // daily, two weeks
                Tier {
                    every_secs: 7 * 24 * 60 * 60,
                    keep: 13,
                }, // weekly, a quarter
            ],
            max_total_bytes: None,
        }
    }
}

/// What a retention pass decided.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RetentionPlan {
    /// Newest first; snapshots to delete.
    pub delete: Vec<SnapshotId>,
    /// Newest first; snapshots explicitly kept because of a rule.
    pub keep: Vec<SnapshotId>,
}

impl RetentionPolicy {
    /// Decide which snapshots to keep. Input order does not matter.
    ///
    /// Deterministic: the same set of snapshots always yields the same plan.
    pub fn plan(&self, snapshots: &[RetainedSnapshot]) -> RetentionPlan {
        // Newest first; ties broken by id so the plan is stable.
        let mut ordered: Vec<&RetainedSnapshot> = snapshots.iter().collect();
        ordered.sort_by(|a, b| {
            b.created_at_unix_ms
                .cmp(&a.created_at_unix_ms)
                .then_with(|| b.id.as_str().cmp(a.id.as_str()))
        });

        let mut keep: HashMap<&str, bool> = HashMap::new();

        // 1. Protected: pinned, the newest overall, and the newest of each reason.
        let mut seen_reason: HashMap<&str, ()> = HashMap::new();
        for (idx, s) in ordered.iter().enumerate() {
            let newest = idx == 0;
            let first_of_reason = !seen_reason.contains_key(s.reason.as_str());
            if s.pinned || newest || first_of_reason {
                keep.insert(s.id.as_str(), true);
                seen_reason.insert(s.reason.as_str(), ());
            }
        }

        // 2. Always keep the newest keep_min.
        for s in ordered.iter().take(self.keep_min) {
            keep.insert(s.id.as_str(), true);
        }

        // 3. Time tiers: for each bucket, keep the newest snapshot in it.
        for tier in &self.tiers {
            let mut buckets: HashMap<i64, ()> = HashMap::new();
            let mut kept_in_tier = 0usize;
            for s in &ordered {
                if s.created_at_unix_ms <= 0 {
                    continue;
                }
                let bucket = s.created_at_unix_ms / (tier.every_secs * 1000);
                if buckets.contains_key(&bucket) {
                    continue;
                }
                if kept_in_tier >= tier.keep {
                    break;
                }
                buckets.insert(bucket, ());
                keep.insert(s.id.as_str(), true);
                kept_in_tier += 1;
            }
        }

        // 4. keep_max: if still too many, drop the oldest unprotected.
        let mut kept: Vec<&RetainedSnapshot> = ordered
            .iter()
            .copied()
            .filter(|s| keep.contains_key(s.id.as_str()))
            .collect();
        if kept.len() > self.keep_max {
            // Keep order newest-first, trim from the tail but never the protected few.
            let protected: std::collections::HashSet<&str> = ordered
                .iter()
                .take(self.keep_min.max(1))
                .map(|s| s.id.as_str())
                .collect();
            let mut to_drop: Vec<&RetainedSnapshot> = Vec::new();
            for s in kept.iter().rev() {
                if kept.len() - to_drop.len() <= self.keep_max {
                    break;
                }
                if s.pinned || protected.contains(s.id.as_str()) {
                    continue;
                }
                to_drop.push(s);
            }
            for s in &to_drop {
                keep.remove(s.id.as_str());
            }
            kept = ordered
                .iter()
                .copied()
                .filter(|s| keep.contains_key(s.id.as_str()))
                .collect();
        }

        // 5. Size cap: evict oldest unprotected until under budget.
        if let Some(cap) = self.max_total_bytes {
            let mut total: u64 = kept.iter().map(|s| s.size_bytes).sum();
            if total > cap {
                let protected: std::collections::HashSet<&str> = ordered
                    .iter()
                    .take(self.keep_min.max(1))
                    .map(|s| s.id.as_str())
                    .collect();
                let mut evict: Vec<&RetainedSnapshot> = Vec::new();
                for s in kept.iter().rev() {
                    if total <= cap {
                        break;
                    }
                    if s.pinned || protected.contains(s.id.as_str()) {
                        continue;
                    }
                    total = total.saturating_sub(s.size_bytes);
                    evict.push(s);
                }
                for s in evict {
                    keep.remove(s.id.as_str());
                }
            }
        }

        let mut delete = Vec::new();
        let mut keep_list = Vec::new();
        for s in &ordered {
            if keep.contains_key(s.id.as_str()) {
                keep_list.push(s.id.clone());
            } else {
                delete.push(s.id.clone());
            }
        }
        RetentionPlan {
            delete,
            keep: keep_list,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(n: u64, mins_ago: i64, reason: &str) -> RetainedSnapshot {
        const NOW: i64 = 1_800_000_000_000;
        RetainedSnapshot {
            id: SnapshotId::from_raw(format!("snap_{n:04}")),
            created_at_unix_ms: NOW - mins_ago * 60_000,
            reason: reason.into(),
            pinned: false,
            size_bytes: 10,
        }
    }

    #[test]
    fn newest_is_always_kept() {
        let policy = RetentionPolicy::default();
        let snaps = vec![snap(1, 0, "scheduled"), snap(2, 9999, "scheduled")];
        let plan = policy.plan(&snaps);
        assert!(plan.keep.contains(&SnapshotId::from_raw("snap_0001")));
    }

    #[test]
    fn newest_of_each_reason_is_protected() {
        let policy = RetentionPolicy::default();
        // A flood of scheduled snapshots, plus one ancient final save.
        let mut snaps: Vec<_> = (0..50)
            .map(|i| snap(i + 10, i as i64, "scheduled"))
            .collect();
        snaps.push(snap(1, 100_000, "final"));
        let plan = policy.plan(&snaps);
        assert!(
            plan.keep.contains(&SnapshotId::from_raw("snap_0001")),
            "the only final snapshot must survive a scheduled flood"
        );
    }

    #[test]
    fn pinned_snapshots_are_never_deleted() {
        let policy = RetentionPolicy::default();
        let mut pinned = snap(1, 100_000, "scheduled");
        pinned.pinned = true;
        let snaps = vec![pinned, snap(2, 0, "scheduled")];
        let plan = policy.plan(&snaps);
        assert!(!plan.delete.contains(&SnapshotId::from_raw("snap_0001")));
    }

    #[test]
    fn older_than_keep_min_and_outside_tiers_gets_pruned() {
        let policy = RetentionPolicy {
            keep_min: 2,
            keep_max: 100,
            tiers: vec![Tier {
                every_secs: 60 * 60,
                keep: 1,
            }],
            max_total_bytes: None,
        };
        // Three snapshots one minute apart: newest two protected, oldest outside
        // the single hourly bucket (newest of that bucket is another one).
        let snaps = vec![
            snap(1, 0, "scheduled"),
            snap(2, 1, "scheduled"),
            snap(3, 2, "scheduled"),
        ];
        let plan = policy.plan(&snaps);
        assert!(plan.delete.contains(&SnapshotId::from_raw("snap_0003")));
    }

    #[test]
    fn keep_max_caps_the_total() {
        let policy = RetentionPolicy {
            keep_min: 2,
            keep_max: 5,
            tiers: vec![],
            max_total_bytes: None,
        };
        let snaps: Vec<_> = (0..20)
            .map(|i| snap(i + 1, i as i64, "scheduled"))
            .collect();
        let plan = policy.plan(&snaps);
        assert!(plan.keep.len() <= 5);
    }

    #[test]
    fn size_cap_evicts_oldest_first() {
        let policy = RetentionPolicy {
            keep_min: 1,
            keep_max: 100,
            tiers: vec![],
            max_total_bytes: Some(35),
        };
        // Four snapshots of 10 bytes each: keep enough to fit 35 -> at most 3.
        let snaps: Vec<_> = (0..4)
            .map(|i| {
                let mut s = snap(i + 1, i as i64, "scheduled");
                s.size_bytes = 10;
                s
            })
            .collect();
        let plan = policy.plan(&snaps);
        let kept_bytes: u64 = plan
            .keep
            .iter()
            .map(|id| snaps.iter().find(|s| &s.id == id).unwrap().size_bytes)
            .sum();
        assert!(kept_bytes <= 35, "kept {kept_bytes} bytes over cap");
        // The oldest must be the one dropped.
        assert!(!plan.keep.contains(&SnapshotId::from_raw("snap_0004")));
    }

    #[test]
    fn plan_is_deterministic() {
        let policy = RetentionPolicy::default();
        let snaps: Vec<_> = (0..30)
            .map(|i| snap(i + 1, i as i64, "scheduled"))
            .collect();
        let a = policy.plan(&snaps);
        let b = policy.plan(&snaps);
        assert_eq!(a, b);
    }
}
