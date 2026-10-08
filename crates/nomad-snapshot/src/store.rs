//! On-disk chunk store: snapshot, restore, verify, garbage-collect.
//!
//! Layout under the store root:
//!
//! ```text
//! <root>/
//!   chunks/<hh>/<hash>     zstd-compressed chunks, verified on every read
//!   chunks/tmp/            staging area; files are fsynced then atomically renamed
//!   chunks/quarantine/     chunks that failed verification are moved here
//!   snapshots/<id>.json    manifests, keyed by their own digest
//! ```
//!
//! Nothing here is Minecraft-specific: the caller supplies include/exclude patterns
//! and the metadata to stamp onto the manifest.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nomad_proto::ids::SnapshotId;
use nomad_proto::manifest::{validate_relative_path, FileEntry, FileKind, Manifest, PathPattern};
use walkdir::WalkDir;

use crate::chunk::{chunk_bytes, ChunkId};

/// Caller-supplied metadata for a new snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotMeta {
    pub epoch: u64,
    pub node_id: String,
    pub reason: String,
    pub parent: Option<SnapshotId>,
}

/// Summary returned after writing a snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotInfo {
    pub id: SnapshotId,
    pub file_count: usize,
    pub chunk_count: usize,
    /// Chunks that were already present, i.e. bytes saved by dedup.
    pub new_chunks: usize,
    pub total_bytes: u64,
}

/// Result of verifying a snapshot against the chunk store.
#[derive(Debug, Clone, Default)]
pub struct VerifyReport {
    pub files_checked: usize,
    pub chunks_checked: usize,
    pub missing_chunks: Vec<String>,
    pub corrupt_chunks: Vec<String>,
}

impl VerifyReport {
    pub fn is_ok(&self) -> bool {
        self.missing_chunks.is_empty() && self.corrupt_chunks.is_empty()
    }
}

/// Result of restoring a snapshot into a directory.
#[derive(Debug, Clone)]
pub struct RestoreReport {
    pub files_written: usize,
    pub bytes_written: u64,
    /// Paths removed because they existed on disk but not in the snapshot.
    pub removed: Vec<String>,
}

/// Result of a garbage-collection sweep.
#[derive(Debug, Clone, Default)]
pub struct GcReport {
    pub chunks_removed: usize,
    pub bytes_removed: u64,
    pub chunks_kept: usize,
}

/// A content-addressed world store rooted at one directory.
pub struct SnapshotStore {
    root: PathBuf,
}

impl SnapshotStore {
    /// Open (creating if needed) a store at `root`.
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("chunks/tmp"))?;
        fs::create_dir_all(root.join("chunks/quarantine"))?;
        fs::create_dir_all(root.join("snapshots"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn chunks_dir(&self) -> PathBuf {
        self.root.join("chunks")
    }

    fn snapshots_dir(&self) -> PathBuf {
        self.root.join("snapshots")
    }

    /// Chunk path for a given id inside this store.
    fn chunk_path(&self, id: &ChunkId) -> PathBuf {
        self.chunks_dir().join(id.relative_path())
    }

    /// Snapshot the directory `base`, including only paths allowed by `include`.
    ///
    /// Files are read and re-checked for size after reading; anything that changed
    /// underneath us aborts the whole snapshot rather than producing a torn one.
    pub fn snapshot(
        &self,
        base: impl AsRef<Path>,
        include: &[PathPattern],
        meta: SnapshotMeta,
    ) -> anyhow::Result<SnapshotInfo> {
        let base = base.as_ref();
        let mut entries: Vec<FileEntry> = Vec::new();
        let mut chunks_written = 0usize;
        let mut new_chunks = 0usize;
        let mut total_bytes = 0u64;

        let mut dirs: BTreeSet<String> = BTreeSet::new();

        for entry in WalkDir::new(base).follow_links(false).sort_by_file_name() {
            let entry = entry?;
            let rel = entry
                .path()
                .strip_prefix(base)?
                .to_string_lossy()
                .replace('\\', "/");
            if rel.is_empty() {
                continue;
            }
            validate_relative_path(&rel)?;

            if entry.file_type().is_dir() {
                if PathPattern::allowed(include, &format!("{rel}/")) {
                    dirs.insert(rel);
                }
                continue;
            }
            if !entry.file_type().is_file() {
                // Symlinks and special files are skipped deliberately.
                continue;
            }
            if !PathPattern::allowed(include, &rel) {
                continue;
            }

            let before = entry.metadata()?.len();
            let data = fs::read(entry.path())?;
            if data.len() as u64 != before {
                anyhow::bail!("file changed while snapshotting: {rel}");
            }

            for piece in chunk_bytes(&data) {
                let id = ChunkId::of(piece);
                chunks_written += 1;
                if self.put_chunk(&id, piece)? {
                    new_chunks += 1;
                }
            }

            total_bytes += data.len() as u64;
            entries.push(crate::chunk::file_entry(rel, &data));
        }

        let mut files: Vec<FileEntry> = Vec::with_capacity(entries.len() + dirs.len());
        for d in dirs {
            files.push(FileEntry {
                path: d,
                kind: FileKind::Dir,
                size: 0,
                blake3: String::new(),
                chunks: vec![],
            });
        }
        files.extend(entries);
        files.sort_by(|a, b| a.path.cmp(&b.path));

        let manifest = Manifest {
            format: Manifest::FORMAT,
            epoch: meta.epoch,
            node_id: meta.node_id,
            parent: meta.parent,
            created_at_unix_ms: now_ms(),
            reason: meta.reason,
            files: files.clone(),
        };
        let id = manifest.digest_id()?;
        self.put_manifest(&manifest)?;

        Ok(SnapshotInfo {
            id,
            file_count: files.iter().filter(|f| f.kind == FileKind::File).count(),
            chunk_count: chunks_written,
            new_chunks,
            total_bytes,
        })
    }

    /// Store a chunk if absent. Returns true when a new chunk was written.
    ///
    /// Writes go to `tmp/` and are renamed into place, so a crash never leaves a
    /// half-written chunk under a real id.
    fn put_chunk(&self, id: &ChunkId, plain: &[u8]) -> anyhow::Result<bool> {
        let dest = self.chunk_path(id);
        if dest.exists() {
            return Ok(false);
        }
        let compressed = zstd::encode_all(plain, crate::DEFAULT_ZSTD_LEVEL)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.chunks_dir().join("tmp").join(format!(
            "{}.{}.tmp",
            id.as_str(),
            std::process::id()
        ));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&compressed)?;
            f.sync_all()?;
        }
        // Rename is atomic within a volume; a racing writer just clobbers an
        // identical-content file, which is harmless.
        fs::rename(&tmp, &dest)?;
        Ok(true)
    }

    /// Read and verify a chunk, returning its plaintext.
    fn get_chunk(&self, id: &ChunkId) -> anyhow::Result<Vec<u8>> {
        let path = self.chunk_path(id);
        if !path.exists() {
            anyhow::bail!("missing chunk {}", id);
        }
        let compressed = fs::read(&path)?;
        let plain = zstd::decode_all(&compressed[..])?;
        if ChunkId::of(&plain) != *id {
            let quarantine = self.chunks_dir().join("quarantine").join(id.as_str());
            let _ = fs::rename(&path, &quarantine);
            anyhow::bail!("chunk {} failed verification", id);
        }
        Ok(plain)
    }

    /// Write a manifest under its own digest.
    pub fn put_manifest(&self, manifest: &Manifest) -> anyhow::Result<SnapshotId> {
        let id = manifest.digest_id()?;
        let bytes = manifest.to_canonical_bytes()?;
        let dest = self.snapshots_dir().join(format!("{id}.json"));
        let tmp = self
            .snapshots_dir()
            .join(format!("{id}.{}.tmp", std::process::id()));
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &dest)?;
        Ok(id)
    }

    /// Read a manifest, verifying that its content still hashes to its id.
    pub fn manifest(&self, id: &SnapshotId) -> anyhow::Result<Manifest> {
        let path = self.snapshots_dir().join(format!("{id}.json"));
        let bytes = fs::read(&path)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        if manifest.digest_id()? != *id {
            return Err(nomad_proto::ProtoError::ManifestDigestMismatch.into());
        }
        Ok(manifest)
    }

    /// List snapshot ids present in this store.
    pub fn list_snapshots(&self) -> anyhow::Result<Vec<SnapshotId>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.snapshots_dir())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".json") {
                ids.push(SnapshotId::from_raw(stem.to_string()));
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// Chunk ids a snapshot needs that this store does not yet have.
    pub fn missing_chunks(&self, manifest: &Manifest) -> Vec<String> {
        let mut missing = BTreeSet::new();
        for f in &manifest.files {
            for c in &f.chunks {
                if !self.chunk_path(&ChunkId::from_hex(c.clone())).exists() {
                    missing.insert(c.clone());
                }
            }
        }
        missing.into_iter().collect()
    }

    /// Restore a snapshot into `dest`.
    ///
    /// Each file is written to a temporary path and renamed, so a failure never
    /// leaves a half-written region file. Files present on disk but absent from the
    /// snapshot are removed, matching the world exactly.
    pub fn restore(
        &self,
        id: &SnapshotId,
        dest: impl AsRef<Path>,
        include: &[PathPattern],
    ) -> anyhow::Result<RestoreReport> {
        let dest = dest.as_ref();
        let manifest = self.manifest(id)?;
        fs::create_dir_all(dest)?;

        let mut report = RestoreReport {
            files_written: 0,
            bytes_written: 0,
            removed: vec![],
        };

        let mut expected: BTreeSet<String> = BTreeSet::new();
        for entry in &manifest.files {
            if !PathPattern::allowed(include, &entry.path) {
                continue;
            }
            match entry.kind {
                FileKind::Dir => {
                    fs::create_dir_all(dest.join(&entry.path))?;
                    expected.insert(entry.path.clone());
                }
                FileKind::File => {
                    let mut data = Vec::with_capacity(entry.size as usize);
                    for c in &entry.chunks {
                        let piece = self.get_chunk(&ChunkId::from_hex(c.clone()))?;
                        data.extend_from_slice(&piece);
                    }
                    if hex::encode(blake3::hash(&data).as_bytes()) != entry.blake3 {
                        anyhow::bail!("restored file {} does not match manifest", entry.path);
                    }
                    let target = dest.join(&entry.path);
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let tmp = target.with_extension("nomad-restore-tmp");
                    fs::write(&tmp, &data)?;
                    fs::rename(&tmp, &target)?;
                    report.files_written += 1;
                    report.bytes_written += data.len() as u64;
                    expected.insert(entry.path.clone());
                }
            }
        }

        // Remove files under dest that are allowed by the pattern but absent from
        // the snapshot, so the on-disk world matches the manifest exactly.
        for entry in WalkDir::new(dest).follow_links(false) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(dest)?
                .to_string_lossy()
                .replace('\\', "/");
            if PathPattern::allowed(include, &rel) && !expected.contains(&rel) {
                fs::remove_file(entry.path())?;
                report.removed.push(rel);
            }
        }

        Ok(report)
    }

    /// Verify every chunk referenced by a snapshot without restoring it.
    pub fn verify(&self, id: &SnapshotId) -> anyhow::Result<VerifyReport> {
        let manifest = self.manifest(id)?;
        let mut report = VerifyReport::default();
        for f in &manifest.files {
            if f.kind != FileKind::File {
                continue;
            }
            report.files_checked += 1;
            for c in &f.chunks {
                report.chunks_checked += 1;
                let cid = ChunkId::from_hex(c.clone());
                match self.get_chunk(&cid) {
                    Ok(_) => {}
                    Err(e) => {
                        let msg = e.to_string();
                        if msg.contains("missing chunk") {
                            report.missing_chunks.push(c.clone());
                        } else {
                            report.corrupt_chunks.push(c.clone());
                        }
                    }
                }
            }
        }
        Ok(report)
    }

    /// Delete a manifest. Chunks become eligible for GC.
    pub fn delete_snapshot(&self, id: &SnapshotId) -> anyhow::Result<()> {
        let path = self.snapshots_dir().join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// Remove chunks no longer referenced by any manifest.
    ///
    /// Chunks younger than `grace` are kept, so an in-flight transfer cannot be
    /// swept out from under a peer that is about to reference it.
    pub fn gc(&self, grace: std::time::Duration) -> anyhow::Result<GcReport> {
        let mut referenced: BTreeSet<String> = BTreeSet::new();
        for id in self.list_snapshots()? {
            let m = self.manifest(&id)?;
            for f in &m.files {
                for c in &f.chunks {
                    referenced.insert(c.clone());
                }
            }
        }

        let mut report = GcReport::default();
        let now = SystemTime::now();
        for entry in WalkDir::new(self.chunks_dir())
            .min_depth(2)
            .follow_links(false)
        {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            // Skip anything in tmp/ or quarantine/.
            let rel = entry
                .path()
                .strip_prefix(self.chunks_dir())?
                .to_string_lossy()
                .replace('\\', "/");
            if rel.starts_with("tmp/") || rel.starts_with("quarantine/") {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if referenced.contains(&name) {
                report.chunks_kept += 1;
                continue;
            }
            let age = entry
                .metadata()?
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .unwrap_or_default();
            if age < grace {
                report.chunks_kept += 1;
                continue;
            }
            let size = entry.metadata()?.len();
            fs::remove_file(entry.path())?;
            report.chunks_removed += 1;
            report.bytes_removed += size;
        }
        Ok(report)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
