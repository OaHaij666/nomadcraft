//! End-to-end tests for the chunk store: snapshot, restore, verify, GC.

use std::fs;

use nomad_proto::manifest::PathPattern;
use nomad_snapshot::{SnapshotMeta, SnapshotStore};

fn meta(epoch: u64) -> SnapshotMeta {
    SnapshotMeta {
        epoch,
        node_id: "node_test".into(),
        reason: "manual".into(),
        parent: None,
    }
}

fn world_patterns() -> Vec<PathPattern> {
    vec![
        PathPattern::include("world*/"),
        PathPattern::exclude("world*/session.lock"),
        PathPattern::include("server.properties"),
    ]
}

/// Build a fake world directory with a couple of region-ish files.
fn write_world(dir: &std::path::Path, seed: u8, region_size: usize) {
    fs::create_dir_all(dir.join("world/region")).unwrap();
    let mut region = vec![seed; region_size];
    // Make it less compressible and more chunk-like.
    let mut x: u32 = seed as u32 | 1;
    for b in region.iter_mut() {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        *b = (x >> 24) as u8;
    }
    fs::write(dir.join("world/region/r.0.0.mca"), region).unwrap();
    fs::write(dir.join("world/level.dat"), b"level-data").unwrap();
    // A locked file that must be excluded.
    fs::write(dir.join("world/session.lock"), b"lock").unwrap();
    fs::write(dir.join("server.properties"), b"motd=hello").unwrap();
    // Unrelated file that should not be captured.
    fs::write(dir.join("notes.txt"), b"ignore me").unwrap();
}

#[test]
fn snapshot_then_restore_roundtrips_world() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 1, 3 * 1024 * 1024);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let info = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();
    assert!(info.file_count >= 3);
    assert!(store.verify(&info.id).unwrap().is_ok());

    let dest = tmp.path().join("dest");
    let report = store.restore(&info.id, &dest, &world_patterns()).unwrap();
    assert!(report.files_written >= 3);

    let original = fs::read(src.join("world/region/r.0.0.mca")).unwrap();
    let restored = fs::read(dest.join("world/region/r.0.0.mca")).unwrap();
    assert_eq!(original, restored);
    assert_eq!(
        fs::read(dest.join("server.properties")).unwrap(),
        b"motd=hello"
    );
}

#[test]
fn excluded_and_unrelated_files_are_not_captured() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 2, 1024);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let info = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();
    let manifest = store.manifest(&info.id).unwrap();
    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert!(!paths.iter().any(|p| p.ends_with("session.lock")));
    assert!(!paths.contains(&"notes.txt"));
    assert!(paths.contains(&"world/level.dat"));
}

#[test]
fn dedup_reuses_chunks_across_snapshots() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 3, 4 * 1024 * 1024);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let first = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();
    assert!(first.new_chunks > 0);

    // Change only one small file; the big region file is untouched, so almost
    // every chunk should be reused.
    fs::write(src.join("server.properties"), b"motd=changed").unwrap();
    let second = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();
    assert!(
        second.new_chunks < first.new_chunks,
        "expected dedup to reduce new chunks ({} vs {})",
        second.new_chunks,
        first.new_chunks
    );
    assert!(second.chunk_count >= first.chunk_count);
}

#[test]
fn restore_removes_files_absent_from_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 4, 4096);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let info = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();

    let dest = tmp.path().join("dest");
    store.restore(&info.id, &dest, &world_patterns()).unwrap();
    // Introduce an extra file the snapshot does not know about.
    fs::write(dest.join("world/region/stray.mca"), b"junk").unwrap();
    let report = store.restore(&info.id, &dest, &world_patterns()).unwrap();
    assert!(report.removed.iter().any(|p| p.ends_with("stray.mca")));
    assert!(!dest.join("world/region/stray.mca").exists());
}

#[test]
fn missing_chunk_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 5, 4096);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let info = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();
    let manifest = store.manifest(&info.id).unwrap();

    // Delete one chunk on purpose.
    let chunk = manifest
        .files
        .iter()
        .find(|f| !f.chunks.is_empty())
        .unwrap()
        .chunks[0]
        .clone();
    let (head, _) = chunk.split_at(2);
    fs::remove_file(tmp.path().join("store/chunks").join(head).join(&chunk)).unwrap();

    let report = store.verify(&info.id).unwrap();
    assert!(!report.is_ok());
    assert!(report.missing_chunks.contains(&chunk));
}

#[test]
fn gc_removes_unreferenced_chunks_but_keeps_grace_window() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 6, 2 * 1024 * 1024);

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let info = store.snapshot(&src, &world_patterns(), meta(1)).unwrap();

    // Delete the only manifest; with zero grace the chunks become collectable.
    store.delete_snapshot(&info.id).unwrap();
    let report = store.gc(std::time::Duration::ZERO).unwrap();
    assert!(report.chunks_removed > 0, "expected GC to reclaim chunks");

    // With a generous grace window, fresh chunks are kept.
    let info2 = store.snapshot(&src, &world_patterns(), meta(2)).unwrap();
    store.delete_snapshot(&info2.id).unwrap();
    let kept = store.gc(std::time::Duration::from_secs(3600)).unwrap();
    assert_eq!(kept.chunks_removed, 0);
    assert!(kept.chunks_kept > 0);
}

#[test]
fn manifest_id_is_stable_across_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    write_world(&src, 7, 4096);

    let info = {
        let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
        store.snapshot(&src, &world_patterns(), meta(1)).unwrap()
    };
    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let again = store.manifest(&info.id).unwrap();
    assert_eq!(again.digest_id().unwrap(), info.id);
    assert_eq!(store.list_snapshots().unwrap(), vec![info.id]);
}
