//! The immutable description of a world snapshot.
//!
//! A snapshot is a set of files content-addressed by BLAKE3. Its manifest lists
//! every file (and directory) together with per-file hashes and the content-defined
//! chunks each file is split into. The manifest itself is digested, and the digest
//! *is* the snapshot's identity: a manifest can therefore never change under the
//! same id.
//!
//! Path handling here is deliberately strict. Worlds move between Windows and
//! Linux machines, so we reject anything that could escape the server directory or
//! be interpreted differently by the two platforms.

use serde::{Deserialize, Serialize};

use crate::ids::SnapshotId;

/// Whether a manifest entry is a regular file or a directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
}

/// One entry in a manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    /// Relative, `/`-separated path from the server working directory.
    pub path: String,
    pub kind: FileKind,
    /// Size in bytes. Zero for directories.
    pub size: u64,
    /// Whole-file BLAKE3 (lowercase hex). Empty for directories.
    pub blake3: String,
    /// Ordered content-defined chunk hashes (lowercase hex).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chunks: Vec<String>,
}

/// A content-addressed description of one world state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Manifest format version, bumped on incompatible layout changes.
    pub format: u32,
    /// Epoch this world state was produced under (fencing).
    pub epoch: u64,
    /// Producing node, for provenance and debugging.
    pub node_id: String,
    /// Parent snapshot, when this one descends from another. Enables dedup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<SnapshotId>,
    /// Creation time in Unix milliseconds.
    pub created_at_unix_ms: i64,
    /// Free-form reason: `scheduled`, `manual`, `final`, `migration`.
    pub reason: String,
    /// Entries sorted by path (bytewise), which keeps digests stable.
    pub files: Vec<FileEntry>,
}

impl Manifest {
    pub const FORMAT: u32 = 1;

    /// Serialize to the canonical byte form used for hashing and storage.
    ///
    /// Callers must already have sorted `files`; the constructor helpers do so.
    pub fn to_canonical_bytes(&self) -> crate::Result<Vec<u8>> {
        Ok(serde_json::to_vec(self)?)
    }

    /// Compute the snapshot id: `snap_` plus the first 16 bytes of BLAKE3, base32.
    pub fn digest_id(&self) -> crate::Result<SnapshotId> {
        let bytes = self.to_canonical_bytes()?;
        let digest = blake3::hash(&bytes);
        Ok(SnapshotId::from_raw(format!(
            "snap_{}",
            base32_lower(&digest.as_bytes()[..16])
        )))
    }
}

/// Lowercase RFC4648 base32 without padding. Local helper so we do not pull a dep.
fn base32_lower(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        buffer = (buffer << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0x1f) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

/// A glob-ish include/exclude rule for choosing which files belong in a snapshot.
///
/// `world*/` includes everything under any directory starting with `world`.
/// A leading `!` excludes, e.g. `!world*/session.lock` — Minecraft holds an
/// exclusive lock on that file while running, so it must never be copied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathPattern {
    pub pattern: String,
    pub exclude: bool,
}

impl PathPattern {
    /// Build an include pattern.
    pub fn include(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            exclude: false,
        }
    }

    /// Build an exclude pattern.
    pub fn exclude(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            exclude: true,
        }
    }

    /// Match a relative `/`-separated path against this pattern.
    ///
    /// Supported syntax:
    /// - `world*/` — a directory subtree; matches `world/...` and `world_nether/...`
    /// - `*` — any run of characters except `/`
    /// - `**` — any run of characters, including `/`
    /// - `?` — exactly one character except `/`
    /// - a plain path also matches everything beneath it
    pub fn matches(&self, path: &str) -> bool {
        let pat = self.pattern.as_str();

        // Directory subtree form: "world*/" includes all descendants.
        if let Some(prefix) = pat.strip_suffix("*/") {
            return match path.split_once('/') {
                Some((head, _)) => head.starts_with(prefix),
                None => path.starts_with(prefix),
            };
        }

        // A plain path (no wildcards) also matches everything beneath it, so
        // "server.properties" is exact but "world" would match "world/...".
        if !pat.contains(['*', '?']) {
            return path == pat || path.starts_with(&format!("{pat}/"));
        }

        glob_match(pat, path)
    }

    /// Apply a pattern list: excluded wins, otherwise the path must match an include.
    pub fn allowed(patterns: &[PathPattern], path: &str) -> bool {
        if patterns.iter().any(|p| p.exclude && p.matches(path)) {
            return false;
        }
        let includes: Vec<&PathPattern> = patterns.iter().filter(|p| !p.exclude).collect();
        if includes.is_empty() {
            return true;
        }
        includes.iter().any(|p| p.matches(path))
    }
}

/// Reject paths that could escape the server directory or behave differently
/// across Windows and Linux. Returns a typed error describing the problem.
pub fn validate_relative_path(path: &str) -> crate::Result<()> {
    let bad = |why: &str| Err(crate::ProtoError::UnsafePath(format!("{path}: {why}")));

    if path.is_empty() {
        return bad("empty path");
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return bad("absolute path");
    }
    if path.contains('\\') {
        return bad("backslash separator");
    }
    if path.contains('\0') {
        return bad("NUL byte");
    }
    // Windows drive letter like "C:".
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return bad("drive letter");
    }
    for component in path.split('/') {
        if component.is_empty() {
            return bad("empty path component");
        }
        if component == "." || component == ".." {
            return bad("relative traversal component");
        }
        if component.ends_with(' ') || component.ends_with('.') {
            return bad("trailing space or dot (invalid on Windows)");
        }
        if is_windows_reserved(component) {
            return bad("Windows-reserved device name");
        }
    }
    Ok(())
}

/// Wildcard matcher for include/exclude patterns.
///
/// `*` matches any run of characters except `/`; `**` matches any run including
/// `/`; `?` matches a single character except `/`. Matching is anchored at both
/// ends. Runs in O(pat_len * path_len) with an iterative two-row DP.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (np, nt) = (p.len(), t.len());

    // prev[j] == "first i pattern chars can match first j text chars"
    let mut prev = vec![false; nt + 1];
    prev[0] = true;

    for i in 1..=np {
        let mut cur = vec![false; nt + 1];
        let pc = p[i - 1];
        match pc {
            '*' => {
                // Collapse "**" into a single token that spans '/'.
                let spans_slash = i >= 2 && p[i - 2] == '*';
                cur[0] = prev[0];
                for j in 1..=nt {
                    let eat = if spans_slash { true } else { t[j - 1] != '/' };
                    cur[j] = cur[j - 1] && eat || prev[j];
                }
            }
            '?' => {
                for j in 1..=nt {
                    cur[j] = prev[j - 1] && t[j - 1] != '/';
                }
            }
            _ => {
                for j in 1..=nt {
                    cur[j] = prev[j - 1] && p[i - 1] == t[j - 1];
                }
            }
        }
        prev = cur;
    }
    prev[nt]
}

fn is_windows_reserved(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name);
    RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> FileEntry {
        FileEntry {
            path: path.into(),
            kind: FileKind::File,
            size: 1,
            blake3: "aa".repeat(32),
            chunks: vec!["bb".repeat(32)],
        }
    }

    #[test]
    fn digest_is_stable_and_prefixed() {
        let m = Manifest {
            format: Manifest::FORMAT,
            epoch: 3,
            node_id: "node_x".into(),
            parent: None,
            created_at_unix_ms: 1,
            reason: "manual".into(),
            files: vec![entry("world/level.dat")],
        };
        let a = m.digest_id().unwrap();
        let b = m.digest_id().unwrap();
        assert_eq!(a, b);
        assert!(a.as_str().starts_with("snap_"));
    }

    #[test]
    fn path_validation_blocks_escapes() {
        assert!(validate_relative_path("world/level.dat").is_ok());
        assert!(validate_relative_path("../etc/passwd").is_err());
        assert!(validate_relative_path("/abs").is_err());
        assert!(validate_relative_path("C:/win").is_err());
        assert!(validate_relative_path("world/CON").is_err());
        assert!(validate_relative_path("world/trailing.").is_err());
    }

    #[test]
    fn patterns_include_and_exclude() {
        let pats = vec![
            PathPattern::include("world*/"),
            PathPattern::exclude("world*/session.lock"),
        ];
        assert!(PathPattern::allowed(&pats, "world/level.dat"));
        assert!(PathPattern::allowed(&pats, "world_nether/region/r.0.0.mca"));
        assert!(!PathPattern::allowed(&pats, "world/session.lock"));
        assert!(!PathPattern::allowed(&pats, "server.properties"));
    }

    #[test]
    fn glob_handles_middle_wildcard() {
        assert!(glob_match("world*/session.lock", "world/session.lock"));
        assert!(glob_match(
            "world*/session.lock",
            "world_nether/session.lock"
        ));
        assert!(!glob_match("world*/session.lock", "world/level.dat"));
        assert!(glob_match("r.*.mca", "r.0.0.mca"));
        assert!(!glob_match("r.*.mca", "r.0.0.mca.bak"));
    }

    #[test]
    fn star_does_not_cross_slash_but_double_does() {
        // single '*' stays within one path segment
        assert!(glob_match("a/*/c", "a/b/c"));
        assert!(!glob_match("a/*/c", "a/b/x/c"));
        // '**' may span several segments
        assert!(glob_match("a/**/c", "a/b/c"));
        assert!(glob_match("a/**/c", "a/b/x/c"));
        // and matching is anchored at both ends
        assert!(!glob_match("a/**/c", "a/b/c/x"));
    }

    #[test]
    fn base32_is_lowercase_alphabet() {
        let s = base32_lower(&[0xff, 0x00, 0x11]);
        assert!(s
            .chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
    }
}
