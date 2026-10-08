//! Replicating snapshots between stores.
//!
//! Replication is chunk-level and idempotent: the sender computes which chunks the
//! receiver is missing and transfers only those. Re-running after an interruption
//! simply re-asks for what is still absent, so there is no resume bookkeeping to
//! get wrong.
//!
//! The transport is deliberately abstract. In production chunks ride the peer mesh
//! or the control plane's store; in tests they are handed over in memory. Either
//! way the receiving side verifies every chunk before storing it.

use std::collections::BTreeSet;

use nomad_proto::ids::SnapshotId;
use nomad_proto::manifest::{FileKind, Manifest};

use crate::chunk::ChunkId;
use crate::store::SnapshotStore;

/// What a replication attempt moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Chunks the receiver already had; nothing was transferred for these.
    pub reused_chunks: usize,
    /// Chunks actually transferred and stored.
    pub transferred_chunks: usize,
    /// Bytes transferred (compressed).
    pub transferred_bytes: u64,
}

impl SyncReport {
    /// Total chunks the snapshot needs.
    pub fn total_chunks(&self) -> usize {
        self.reused_chunks + self.transferred_chunks
    }

    /// Fraction of chunks that did not need transferring, 0.0..=1.0.
    pub fn reuse_ratio(&self) -> f64 {
        let total = self.total_chunks();
        if total == 0 {
            return 1.0;
        }
        self.reused_chunks as f64 / total as f64
    }
}

/// Every chunk id referenced by a manifest, deduplicated.
pub fn referenced_chunks(manifest: &Manifest) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    for f in &manifest.files {
        if f.kind != FileKind::File {
            continue;
        }
        for c in &f.chunks {
            set.insert(c.clone());
        }
    }
    set
}

/// Pull a snapshot into `store`, transferring only the chunks it lacks.
///
/// The manifest itself is stored first so a partially-replicated snapshot is
/// visible (and resumable) rather than invisible.
pub async fn pull<F, Fut>(
    store: &SnapshotStore,
    manifest: &Manifest,
    fetch: F,
) -> anyhow::Result<SyncReport>
where
    F: Fn(ChunkId) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<u8>>>,
{
    // Store the manifest so the snapshot id is resolvable while chunks arrive.
    store.put_manifest(manifest)?;

    let mut report = SyncReport::default();
    for hex_id in referenced_chunks(manifest) {
        let id = ChunkId::from_hex(hex_id);
        if store.has_chunk(&id) {
            report.reused_chunks += 1;
            continue;
        }
        let compressed = fetch(id.clone()).await?;
        let bytes = compressed.len() as u64;
        store.import_chunk(&id, &compressed)?;
        report.transferred_chunks += 1;
        report.transferred_bytes += bytes;
    }
    Ok(report)
}

/// List the chunk ids a receiver is missing for a manifest.
///
/// A sender uses this to stream exactly what the receiver asked for.
pub fn missing_chunks_for(store: &SnapshotStore, manifest: &Manifest) -> Vec<ChunkId> {
    referenced_chunks(manifest)
        .into_iter()
        .map(ChunkId::from_hex)
        .filter(|id| !store.has_chunk(id))
        .collect()
}

/// Confirm that `store` holds every chunk a snapshot needs.
pub fn is_complete(store: &SnapshotStore, snapshot: &SnapshotId) -> anyhow::Result<bool> {
    let manifest = store.manifest(snapshot)?;
    Ok(missing_chunks_for(store, &manifest).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SnapshotMeta;
    use nomad_proto::manifest::PathPattern;

    fn meta(epoch: u64) -> SnapshotMeta {
        SnapshotMeta {
            epoch,
            node_id: "node_test".into(),
            reason: "scheduled".into(),
            parent: None,
        }
    }

    fn patterns() -> Vec<PathPattern> {
        vec![PathPattern::include("world*/")]
    }

    fn make_world(dir: &std::path::Path, seed: u8, size: usize) {
        std::fs::create_dir_all(dir.join("world/region")).unwrap();
        let mut data = vec![seed; size];
        let mut x: u32 = seed as u32 | 1;
        for b in data.iter_mut() {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            *b = (x >> 24) as u8;
        }
        std::fs::write(dir.join("world/region/r.0.0.mca"), data).unwrap();
        std::fs::write(dir.join("world/level.dat"), b"level").unwrap();
    }

    #[tokio::test]
    async fn pull_transfers_only_missing_chunks() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        make_world(&src_dir, 1, 3 * 1024 * 1024);

        let source = SnapshotStore::open(tmp.path().join("source")).unwrap();
        let info = source.snapshot(&src_dir, &patterns(), meta(1)).unwrap();
        let manifest = source.manifest(&info.id).unwrap();

        // Receiver starts empty: everything must transfer.
        let receiver = SnapshotStore::open(tmp.path().join("receiver")).unwrap();
        let first = pull(&receiver, &manifest, |id| {
            let source = &source;
            async move { source.chunk_compressed(&id) }
        })
        .await
        .unwrap();
        assert!(first.transferred_chunks > 0);
        assert_eq!(first.reused_chunks, 0);
        assert!(is_complete(&receiver, &info.id).unwrap());

        // Pulling again transfers nothing: the receiver already has every chunk.
        let second = pull(&receiver, &manifest, |id| {
            let source = &source;
            async move { source.chunk_compressed(&id) }
        })
        .await
        .unwrap();
        assert_eq!(second.transferred_chunks, 0);
        assert_eq!(second.reused_chunks, first.transferred_chunks);
        assert_eq!(second.reuse_ratio(), 1.0);
    }

    #[tokio::test]
    async fn incremental_pull_after_a_small_edit_moves_little() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        make_world(&src_dir, 2, 6 * 1024 * 1024);

        let source = SnapshotStore::open(tmp.path().join("source")).unwrap();
        let receiver = SnapshotStore::open(tmp.path().join("receiver")).unwrap();

        let v1 = source.snapshot(&src_dir, &patterns(), meta(1)).unwrap();
        let m1 = source.manifest(&v1.id).unwrap();
        pull(&receiver, &m1, |id| {
            let source = &source;
            async move { source.chunk_compressed(&id) }
        })
        .await
        .unwrap();

        // Edit one small file and re-snapshot.
        std::fs::write(src_dir.join("world/level.dat"), b"level-v2-changed").unwrap();
        let v2 = source.snapshot(&src_dir, &patterns(), meta(1)).unwrap();
        let m2 = source.manifest(&v2.id).unwrap();

        let incr = pull(&receiver, &m2, |id| {
            let source = &source;
            async move { source.chunk_compressed(&id) }
        })
        .await
        .unwrap();

        assert!(incr.reused_chunks > 0, "expected most chunks to be reused");
        assert!(
            incr.transferred_chunks < v1.chunk_count,
            "incremental sync should move fewer chunks than a full copy"
        );
    }

    #[tokio::test]
    async fn a_corrupt_chunk_from_a_peer_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        make_world(&src_dir, 3, 512 * 1024);

        let source = SnapshotStore::open(tmp.path().join("source")).unwrap();
        let info = source.snapshot(&src_dir, &patterns(), meta(1)).unwrap();
        let manifest = source.manifest(&info.id).unwrap();
        let receiver = SnapshotStore::open(tmp.path().join("receiver")).unwrap();

        // A malicious peer returns a chunk that does not match its id.
        let result = pull(&receiver, &manifest, |_id| async move {
            let bogus = zstd::encode_all(&b"not the real bytes"[..], 3)?;
            Ok(bogus)
        })
        .await;
        assert!(result.is_err(), "corrupt chunk must fail the pull");
    }

    #[test]
    fn referenced_chunks_are_deduplicated() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        make_world(&src, 4, 1024 * 1024);
        let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
        let info = store.snapshot(&src, &patterns(), meta(1)).unwrap();
        let manifest = store.manifest(&info.id).unwrap();

        let refs = referenced_chunks(&manifest);
        let mut all: Vec<String> = manifest
            .files
            .iter()
            .flat_map(|f| f.chunks.clone())
            .collect();
        let before = all.len();
        all.sort();
        all.dedup();
        assert_eq!(refs.len(), all.len());
        assert!(refs.len() <= before);
    }
}
