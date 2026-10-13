use serde_json::Value;

/// The minimum Numen adapter target matrix. Keep this in one place so the
/// executor, release validator and UI agree on the supported combinations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NumenTarget {
    pub id: &'static str,
    pub minecraft: &'static str,
    pub loader: &'static str,
    pub java: u8,
    pub numen_sha256: &'static str,
}

pub const NUMEN_TARGETS: &[NumenTarget] = &[
    NumenTarget { id: "1.20.1-fabric", minecraft: "1.20.1", loader: "fabric", java: 17, numen_sha256: "804ccf75021d0a19825f1fe5cdd8864e4585c9cda5ed8665e7abb267559fddd6" },
    NumenTarget { id: "1.20.1-forge", minecraft: "1.20.1", loader: "forge", java: 17, numen_sha256: "e8b95d53bc524cc5d4326edfcbedc76aa2ce9dee0fa5db2f30a962d4797c5ea4" },
    NumenTarget { id: "1.21.1-fabric", minecraft: "1.21.1", loader: "fabric", java: 21, numen_sha256: "ccc0806fd04cf3404dbc39f7579a4d7c20cd1362d06dce358850f5fdaf711a41" },
    NumenTarget { id: "1.21.1-neoforge", minecraft: "1.21.1", loader: "neoforge", java: 21, numen_sha256: "ed4a5936aa182b0d9ab685cb993da54f72514eafb0838bb9a64cd69962cb1226" },
];

pub fn target_for(release: &Value) -> Option<&'static NumenTarget> {
    let minecraft = release["profile"]["mcVersion"].as_str()?;
    let loader = release["server"]["type"].as_str()?;
    NUMEN_TARGETS.iter().find(|target| target.minecraft == minecraft && target.loader == loader)
}

pub fn adapter_file_name(target: &NumenTarget) -> String {
    format!("nomad-numen-adapter-{}-{}.jar", target.loader, target.minecraft)
}
