//! Content-defined chunking and chunk identity.

use nomad_proto::manifest::FileEntry;

/// A chunk's identity: the BLAKE3 hash of its *plaintext* bytes.
///
/// Hashing plaintext (not the compressed form) means the same bytes dedup no matter
/// which compression level or zstd version produced them.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChunkId(String);

impl ChunkId {
    /// Wrap a lowercase hex hash. The caller is responsible for length/format.
    pub fn from_hex(hex: impl Into<String>) -> Self {
        Self(hex.into())
    }

    /// Hash a byte slice and return its id.
    pub fn of(bytes: &[u8]) -> Self {
        Self(blake3::hash(bytes).to_hex().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Path within a chunk store: `<first two hex>/<full hex>`.
    pub fn relative_path(&self) -> String {
        let (head, _) = self.0.split_at(2.min(self.0.len()));
        format!("{head}/{}", self.0)
    }
}

impl std::fmt::Display for ChunkId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Split a byte slice into content-defined chunks with default parameters.
pub fn chunk_bytes(data: &[u8]) -> Vec<&[u8]> {
    chunk_with(data, DEFAULT_AVG, DEFAULT_MIN, DEFAULT_MAX)
}

const DEFAULT_MIN: u32 = 256 * 1024;
const DEFAULT_AVG: u32 = 1024 * 1024;
const DEFAULT_MAX: u32 = 4 * 1024 * 1024;

fn chunk_with(data: &[u8], avg: u32, min: u32, max: u32) -> Vec<&[u8]> {
    let chunker = fastcdc::v2020::FastCDC::new(data, min, avg, max);
    chunker
        .map(|c| &data[c.offset..c.offset + c.length])
        .collect()
}

/// Hash every chunk of a file, returning the ordered chunk ids.
pub fn chunks_of(data: &[u8]) -> Vec<ChunkId> {
    chunk_bytes(data).into_iter().map(ChunkId::of).collect()
}

/// Build a manifest entry for a regular file.
pub fn file_entry(path: String, data: &[u8]) -> FileEntry {
    FileEntry {
        path,
        kind: nomad_proto::manifest::FileKind::File,
        size: data.len() as u64,
        blake3: blake3::hash(data).to_hex().to_string(),
        chunks: chunks_of(data).into_iter().map(|c| c.0).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_input_is_one_chunk() {
        let data = b"hello world";
        assert_eq!(chunk_bytes(data).len(), 1);
    }

    #[test]
    fn large_input_splits_into_several() {
        // 12 MiB of pseudo-random-ish data with an average 1 MiB chunk size
        // should produce multiple chunks.
        let mut data = vec![0u8; 12 * 1024 * 1024];
        let mut x: u32 = 0x1234_5678;
        for b in data.iter_mut() {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            *b = (x >> 24) as u8;
        }
        let chunks = chunk_bytes(&data);
        assert!(
            chunks.len() > 3,
            "expected several chunks, got {}",
            chunks.len()
        );
        let total: usize = chunks.iter().map(|c| c.len()).sum();
        assert_eq!(total, data.len(), "chunking must not lose bytes");
    }

    #[test]
    fn insertion_only_disturbs_nearby_chunks() {
        let mut a = vec![7u8; 8 * 1024 * 1024];
        let mut x: u32 = 1;
        for b in a.iter_mut() {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            *b = (x >> 16) as u8;
        }
        let ids_a: Vec<String> = chunks_of(&a).into_iter().map(|c| c.0).collect();

        // Insert 64 bytes in the middle; content-defined boundaries should mostly
        // survive, so most chunk hashes reappear.
        let mut b = a.clone();
        let mid = b.len() / 2;
        b.splice(mid..mid, std::iter::repeat_n(0u8, 64));
        let ids_b: Vec<String> = chunks_of(&b).into_iter().map(|c| c.0).collect();

        let shared = ids_a.iter().filter(|h| ids_b.contains(h)).count();
        assert!(
            shared >= ids_a.len() / 2,
            "expected most chunks to be reused after a small edit ({shared}/{} shared)",
            ids_a.len()
        );
    }

    #[test]
    fn empty_file_hashes_without_chunks() {
        let e = file_entry("empty".into(), b"");
        assert_eq!(e.size, 0);
        assert_eq!(e.blake3, blake3::hash(b"").to_hex().to_string());
    }

    #[test]
    fn chunk_path_is_prefixed_by_hash_head() {
        let id = ChunkId::of(b"abc");
        let p = id.relative_path();
        assert!(p.starts_with(&id.as_str()[..2]));
        assert!(p.ends_with(id.as_str()));
    }
}
