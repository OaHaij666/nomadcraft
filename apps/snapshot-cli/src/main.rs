//! `nomad-snapshot` CLI — the daemon's bridge to the world-snapshot engine.
//!
//! The daemon is TypeScript and the snapshot engine is Rust, and the engine is
//! the part that must never be re-implemented: FastCDC boundaries, BLAKE3 chunk
//! identity, the canonical manifest encoding that *is* the snapshot id, and the
//! verification on read. Re-deriving any of that in JavaScript would be a second
//! source of truth waiting to disagree with the first.
//!
//! So the daemon shells out to this binary and talks JSON over a file/pipe. The
//! commands are deliberately narrow:
//!
//! * `snapshot <dir> <store>`   — snapshot a directory, print JSON metadata
//! * `restore <store> <id> <dir>` — restore a snapshot into a directory
//! * `verify <store> <id>`      — verify a snapshot without restoring
//! * `list <store>`             — list snapshot ids in a store
//!
//! Paths on the wire use `/`; the engine already rejects anything unsafe.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use nomad_proto::ids::SnapshotId;
use nomad_proto::manifest::PathPattern;
use nomad_snapshot::{SnapshotMeta, SnapshotStore};

#[derive(Parser, Debug)]
#[command(name = "nomad-snapshot", version, about = "NomadCraft world snapshot engine")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Snapshot a directory into a store and print the result as JSON.
    Snapshot {
        /// Directory to snapshot (the running server's working directory).
        dir: PathBuf,
        /// Snapshot store root.
        store: PathBuf,
        /// Node id to stamp into the manifest.
        #[arg(long, default_value = "node_local")]
        node: String,
        /// Epoch to stamp into the manifest.
        #[arg(long, default_value_t = 0)]
        epoch: u64,
        /// Comma-separated include patterns. Omit to include everything.
        ///
        /// Example: `--include world*/ --include server.properties`
        #[arg(long = "include", value_delimiter = ',')]
        include: Vec<String>,
        /// Comma-separated exclude patterns.
        ///
        /// Example: `--exclude world*/session.lock --exclude logs/`
        #[arg(long = "exclude", value_delimiter = ',')]
        exclude: Vec<String>,
        /// Parent snapshot id, when this checkpoint descends from one.
        #[arg(long)]
        parent: Option<String>,
        /// Why this snapshot was taken: scheduled, manual, final, migration.
        #[arg(long, default_value = "scheduled")]
        reason: String,
    },
    /// Restore a snapshot's contents into a directory.
    Restore {
        store: PathBuf,
        id: String,
        dest: PathBuf,
    },
    /// Import a manifest (read from a file) into a store, verifying its digest id.
    ///
    /// Used when a machine pulls a snapshot from a peer: the chunks arrive over the
    /// network, and the manifest must land in the local store under the id its own
    /// bytes hash to — never a caller-chosen name.
    ImportManifest {
        store: PathBuf,
        /// Path to a JSON file holding the manifest.
        manifest: PathBuf,
        /// The id the manifest is expected to hash to.
        #[arg(long)]
        expect: String,
    },
    /// Verify every chunk referenced by a snapshot.
    Verify {
        store: PathBuf,
        id: String,
    },
    /// List the snapshot ids in a store, newest first is not guaranteed.
    List { store: PathBuf },
}

fn patterns(include: &[String], exclude: &[String]) -> Vec<PathPattern> {
    let mut out = Vec::new();
    for p in exclude {
        out.push(PathPattern::exclude(p.clone()));
    }
    for p in include {
        out.push(PathPattern::include(p.clone()));
    }
    out
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Snapshot {
            dir,
            store,
            node,
            epoch,
            include,
            exclude,
            parent,
            reason,
        } => {
            let store = SnapshotStore::open(&store)?;
            let include = patterns(&include, &exclude);
            let meta = SnapshotMeta {
                epoch,
                node_id: node,
                parent: parent.map(SnapshotId::parse).transpose()?,
                reason,
            };
            let info = store.snapshot(&dir, &include, meta)?;
            let manifest = store.manifest(&info.id)?;
            let json = serde_json::json!({
                "snapshot_id": info.id.as_str(),
                "file_count": info.file_count,
                "chunk_count": info.chunk_count,
                "new_chunks": info.new_chunks,
                "total_bytes": info.total_bytes,
                "manifest": manifest,
            });
            println!("{}", serde_json::to_string(&json)?);
        }
        Command::ImportManifest {
            store,
            manifest,
            expect,
        } => {
            let store = SnapshotStore::open(&store)?;
            let expected = SnapshotId::parse(expect)?;
            let raw = std::fs::read(&manifest)?;
            let manifest: nomad_proto::manifest::Manifest = serde_json::from_slice(&raw)?;
            let id = store.put_manifest(&manifest)?;
            if id != expected {
                anyhow::bail!(
                    "manifest digest {id} does not match expected {expected}"
                );
            }
            let json = serde_json::json!({ "snapshot_id": id.as_str() });
            println!("{}", serde_json::to_string(&json)?);
        }
        Command::Restore { store, id, dest } => {
            let store = SnapshotStore::open(&store)?;
            let id = SnapshotId::parse(id)?;
            let include: Vec<PathPattern> = Vec::new();
            let report = store.restore(&id, &dest, &include)?;
            let json = serde_json::json!({
                "files_written": report.files_written,
                "bytes_written": report.bytes_written,
                "removed": report.removed,
            });
            println!("{}", serde_json::to_string(&json)?);
        }
        Command::Verify { store, id } => {
            let store = SnapshotStore::open(&store)?;
            let id = SnapshotId::parse(id)?;
            match store.verify(&id) {
                Ok(report) => {
                    let json = serde_json::json!({
                        "ok": report.is_ok(),
                        "files_checked": report.files_checked,
                        "chunks_checked": report.chunks_checked,
                        "missing_chunks": report.missing_chunks,
                        "corrupt_chunks": report.corrupt_chunks,
                    });
                    println!("{}", serde_json::to_string(&json)?);
                    if !report.is_ok() {
                        std::process::exit(2);
                    }
                }
                Err(e) => {
                    println!("{}", serde_json::json!({ "ok": false, "error": e.to_string() }));
                    std::process::exit(2);
                }
            }
        }
        Command::List { store } => {
            let store = SnapshotStore::open(&store)?;
            let ids: Vec<String> = store
                .list_snapshots()?
                .into_iter()
                .map(|s| s.as_str().to_string())
                .collect();
            println!("{}", serde_json::to_string(&ids)?);
        }
    }
    Ok(())
}





