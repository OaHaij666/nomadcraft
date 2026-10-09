//! World snapshots.
//!
//! A snapshot captures a consistent copy of a Minecraft world (and the files that
//! travel with it) as content-addressed chunks. Two properties matter more than
//! speed:
//!
//! 1. **Immutability.** A snapshot's id is the BLAKE3 digest of its manifest, so a
//!    manifest can never change under the same id.
//! 2. **Verifiability.** Every chunk is re-hashed on read. If a byte flips, we find
//!    out instead of silently restoring a corrupt world.
//!
//! Chunking is content-defined (FastCDC), which means inserting a few bytes into a
//! region file only rewrites the chunks around the edit instead of shifting every
//! subsequent boundary — that is what makes per-checkpoint uploads affordable.
//!
//! The crate also carries the two pieces that turn a local store into a durable
//! backup: the `sync` module moves only the chunks a peer is missing, and the
//! `retention` module decides which historical versions to keep so a rollback
//! target always exists.

mod chunk;
mod retention;
mod store;
mod sync;

pub use chunk::{chunk_bytes, ChunkId};
pub use retention::{RetainedSnapshot, RetentionPlan, RetentionPolicy, Tier};
pub use store::{GcReport, RestoreReport, SnapshotInfo, SnapshotMeta, SnapshotStore, VerifyReport};
pub use sync::{
    descends_from, is_complete, missing_chunks_for, pull, referenced_chunks, SyncReport,
};

/// Default target chunk size (average). Minecraft region files are a few MB, so a
/// ~1 MiB average keeps dedup useful without producing millions of tiny chunks.
pub const DEFAULT_MIN_CHUNK: u64 = 256 * 1024;
pub const DEFAULT_AVG_CHUNK: u64 = 1024 * 1024;
pub const DEFAULT_MAX_CHUNK: u64 = 4 * 1024 * 1024;
pub const DEFAULT_ZSTD_LEVEL: i32 = 3;

/// Which files under a world directory belong in a snapshot.
pub use nomad_proto::manifest::{Manifest, PathPattern};
