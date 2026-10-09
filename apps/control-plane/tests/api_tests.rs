//! End-to-end HTTP tests for the control plane.
//!
//! These drive the real router in-process, so they cover routing, JSON shapes,
//! status codes, and the durability flow (upload chunks -> commit checkpoint ->
//! another node downloads them) exactly as an agent would experience it.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use nomad_control_plane::api;
use nomad_proto::ids::{ServerId, SnapshotId};
use nomad_proto::manifest::PathPattern;
use nomad_snapshot::{ChunkId, SnapshotMeta, SnapshotStore};

fn app(dir: &std::path::Path) -> axum::Router {
    let state = api::AppState::open(dir).unwrap();
    api::router(state)
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            builder.body(Body::from(v.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes)
}

async fn call_bytes(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::from(body))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes)
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn healthz_responds_ok() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    let (status, body) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"ok");
}

#[tokio::test]
async fn register_then_list_nodes() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());

    let (status, body) = call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({
            "name": "gaming-pc",
            "public_key": "pk_abc",
            "cpu_cores": 12,
            "memory_mb": 32768,
            "uplink_mbps": 80.0,
            "anchor": false
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let node_id = json(&body)["node_id"].as_str().unwrap().to_string();
    assert!(node_id.starts_with("node_"));

    let (status, body) = call(&app, "GET", "/v1/nodes", None).await;
    assert_eq!(status, StatusCode::OK);
    let nodes = json(&body);
    assert_eq!(nodes.as_array().unwrap().len(), 1);
    assert_eq!(nodes[0]["cpu_cores"], 12);
}

#[tokio::test]
async fn empty_node_name_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    let (status, body) = call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["code"], "bad_request");
}

#[tokio::test]
async fn claim_elects_the_stronger_node_and_conflicts_on_a_second_claim() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());

    for (name, cores) in [("weak", 4), ("strong", 16)] {
        call(
            &app,
            "POST",
            "/v1/nodes/register",
            Some(serde_json::json!({ "name": name, "cpu_cores": cores, "memory_mb": 8192 })),
        )
        .await;
    }

    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "friends" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();

    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let lease = json(&body);
    assert_eq!(lease["epoch"], 1);
    let host = lease["node_id"].as_str().unwrap();
    // The stronger machine (16 cores) should have won.
    let (_, nodes_body) = call(&app, "GET", "/v1/nodes", None).await;
    let nodes = json(&nodes_body);
    let strong = nodes
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["cpu_cores"] == 16)
        .unwrap();
    assert_eq!(strong["node_id"].as_str().unwrap(), host);

    // A second claim while the lease is live must conflict.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json(&body)["code"], "host_busy");
}

#[tokio::test]
async fn releasing_hands_over_to_a_different_node_at_a_higher_epoch() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    for (name, cores) in [("a", 16), ("b", 4)] {
        call(
            &app,
            "POST",
            "/v1/nodes/register",
            Some(serde_json::json!({ "name": name, "cpu_cores": cores })),
        )
        .await;
    }
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "s" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();

    let (_, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let first = json(&body);
    let first_node = first["node_id"].as_str().unwrap().to_string();

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/release"),
        Some(serde_json::json!({ "node_id": first_node, "epoch": 1, "reason": "user_quit" })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let second = json(&body);
    assert_eq!(second["epoch"], 2);
    assert_ne!(second["node_id"].as_str().unwrap(), first_node);
}

#[tokio::test]
async fn unknown_server_claim_is_404() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "n" })),
    )
    .await;
    let ghost = ServerId::generate();
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{ghost}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["code"], "not_found");
}

/// The durability flow end to end, over HTTP, exactly as two agents would do it:
/// node A snapshots a world, uploads the manifest and every chunk, commits the
/// checkpoint; node B then pulls the manifest and only the chunks it lacks, and
/// reconstructs the world. This is "a crash costs minutes, not a world".
#[tokio::test]
async fn checkpoint_upload_then_pull_reconstructs_the_world() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());

    // Register a host and create a server.
    call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "host", "cpu_cores": 8 })),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "world" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();

    // Host claims hosting.
    let (_, lease_body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let lease = json(&lease_body);
    let host_id = lease["node_id"].as_str().unwrap().to_string();
    let epoch = lease["epoch"].as_u64().unwrap();
    assert_eq!(epoch, 1);

    // Build a real world on disk and snapshot it into a local store.
    let world = tmp.path().join("world-src");
    std::fs::create_dir_all(world.join("world/region")).unwrap();
    let mut region = vec![0u8; 3 * 1024 * 1024];
    let mut x: u32 = 7;
    for b in region.iter_mut() {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        *b = (x >> 24) as u8;
    }
    std::fs::write(world.join("world/region/r.0.0.mca"), &region).unwrap();
    std::fs::write(world.join("world/level.dat"), b"level-1").unwrap();

    let local = SnapshotStore::open(tmp.path().join("host-store")).unwrap();
    let patterns = vec![PathPattern::include("world*/")];
    let info = local
        .snapshot(
            &world,
            &patterns,
            SnapshotMeta {
                epoch,
                node_id: host_id.clone(),
                reason: "scheduled".into(),
                parent: None,
            },
        )
        .unwrap();
    let manifest = local.manifest(&info.id).unwrap();

    // Upload the manifest (its digest must match the path).
    let (status, _) = call_bytes(
        &app,
        "PUT",
        &format!("/v1/snapshots/{}/manifest", info.id),
        manifest.to_canonical_bytes().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "manifest upload");

    // A manifest stored under the wrong id must be refused.
    let wrong = SnapshotId::from_raw("snap_00000000000000000000000000");
    let (status, _) = call_bytes(
        &app,
        "PUT",
        &format!("/v1/snapshots/{wrong}/manifest"),
        manifest.to_canonical_bytes().unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "mismatched digest rejected"
    );

    // Upload every chunk of the snapshot.
    for file in &manifest.files {
        for hash in &file.chunks {
            let chunk = ChunkId::from_hex(hash.clone());
            let bytes = local.chunk_compressed(&chunk).unwrap();
            let (status, _) = call_bytes(
                &app,
                "PUT",
                &format!("/v1/snapshots/{}/chunks/{hash}", info.id),
                bytes,
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "chunk upload {hash}");
        }
    }

    // Only now can the checkpoint be committed.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host_id,
            "epoch": epoch,
            "snapshot_id": info.id,
            "reason": "scheduled"
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "commit checkpoint: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(json(&body)["committed_snapshot"], info.id.as_str());

    // The server now advertises the committed snapshot.
    let (_, body) = call(&app, "GET", &format!("/v1/servers/{server_id}"), None).await;
    assert_eq!(json(&body)["committed_snapshot"], info.id.as_str());

    // A second machine pulls the manifest and reconstructs the world.
    let (status, body) = call(
        &app,
        "GET",
        &format!("/v1/snapshots/{}/manifest", info.id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resp = json(&body);
    assert!(resp["missing_chunks"].as_array().unwrap().is_empty());

    let peer = SnapshotStore::open(tmp.path().join("peer-store")).unwrap();
    peer.put_manifest(&manifest).unwrap();
    for file in &manifest.files {
        for hash in &file.chunks {
            let (status, bytes) = call(
                &app,
                "GET",
                &format!("/v1/snapshots/{}/chunks/{hash}", info.id),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let chunk = ChunkId::from_hex(hash.clone());
            peer.import_chunk(&chunk, &bytes).unwrap();
        }
    }
    assert!(nomad_snapshot::is_complete(&peer, &info.id).unwrap());

    // Restoring on the peer yields the original bytes.
    let restored = tmp.path().join("restored");
    peer.restore(&info.id, &restored, &patterns).unwrap();
    let original = std::fs::read(world.join("world/region/r.0.0.mca")).unwrap();
    let got = std::fs::read(restored.join("world/region/r.0.0.mca")).unwrap();
    assert_eq!(original, got, "restored region must match the original");
}

#[tokio::test]
async fn committing_an_unknown_snapshot_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "h" })),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "s" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();
    let (_, lease_body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let host = json(&lease_body)["node_id"].as_str().unwrap().to_string();

    // Commit a snapshot we never uploaded: it has no manifest, so it is incomplete.
    let ghost = SnapshotId::from_raw("snap_ffffffffffffffffffffffffffffffff");
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host,
            "epoch": 1,
            "snapshot_id": ghost,
            "reason": "manual"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json(&body)["code"], "incomplete_snapshot");
}

#[tokio::test]
async fn stale_epoch_checkpoint_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());
    call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "h" })),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "s" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();
    let (_, lease_body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let host = json(&lease_body)["node_id"].as_str().unwrap().to_string();

    let snap = SnapshotId::from_raw("snap_abc");
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host,
            "epoch": 99,
            "snapshot_id": snap,
            "reason": "manual"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json(&body)["code"], "stale_epoch");
}

/// A host may only commit a world that descends from the one it was handed.
///
/// This is the anti-fork guard: a machine that restored a stale copy, or simply
/// kept running after losing the lease, must not be able to overwrite the committed
/// world with its own divergent branch.
#[tokio::test]
async fn a_checkpoint_that_does_not_descend_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());

    call(
        &app,
        "POST",
        "/v1/nodes/register",
        Some(serde_json::json!({ "name": "host", "cpu_cores": 8 })),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "world" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();

    let (_, lease_body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/claim"),
        Some(serde_json::json!({})),
    )
    .await;
    let host = json(&lease_body)["node_id"].as_str().unwrap().to_string();
    let epoch = json(&lease_body)["epoch"].as_u64().unwrap();

    // One world on disk; a store that will hold both the committed branch and a
    // divergent sibling.
    let world = tmp.path().join("world-src");
    std::fs::create_dir_all(world.join("world")).unwrap();
    std::fs::write(world.join("world/level.dat"), b"root").unwrap();

    let store = SnapshotStore::open(tmp.path().join("store")).unwrap();
    let patterns = vec![
        PathPattern::include("world*/"),
        PathPattern::include("world"),
    ];

    let meta = |parent: Option<SnapshotId>, reason: &str| SnapshotMeta {
        epoch,
        node_id: host.clone(),
        reason: reason.into(),
        parent,
    };

    let root = store
        .snapshot(&world, &patterns, meta(None, "root"))
        .unwrap();
    let root_manifest = store.manifest(&root.id).unwrap();

    // A legitimate descendant of root.
    std::fs::write(world.join("world/level.dat"), b"child").unwrap();
    let child = store
        .snapshot(&world, &patterns, meta(Some(root.id.clone()), "scheduled"))
        .unwrap();
    let child_manifest = store.manifest(&child.id).unwrap();

    // A divergent sibling: same starting point, different edit, but no parent link.
    std::fs::write(world.join("world/level.dat"), b"sibling").unwrap();
    let sibling = store
        .snapshot(&world, &patterns, meta(None, "manual"))
        .unwrap();
    let sibling_manifest = store.manifest(&sibling.id).unwrap();

    // Helper: upload a snapshot fully, then commit it.
    async fn upload(app: &axum::Router, store: &SnapshotStore, id: &SnapshotId) {
        let manifest = store.manifest(id).unwrap();
        let (status, _) = call_bytes(
            app,
            "PUT",
            &format!("/v1/snapshots/{id}/manifest"),
            manifest.to_canonical_bytes().unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "manifest upload");
        for file in &manifest.files {
            for hash in &file.chunks {
                let chunk = ChunkId::from_hex(hash.clone());
                let bytes = store.chunk_compressed(&chunk).unwrap();
                let (status, _) = call_bytes(
                    app,
                    "PUT",
                    &format!("/v1/snapshots/{id}/chunks/{hash}"),
                    bytes,
                )
                .await;
                assert_eq!(status, StatusCode::NO_CONTENT);
            }
        }
    }

    upload(&app, &store, &root.id).await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host, "epoch": epoch, "snapshot_id": root.id, "reason": "root"
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "first snapshot establishes the world"
    );

    // The descendant is accepted.
    upload(&app, &store, &child.id).await;
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host, "epoch": epoch, "snapshot_id": child.id, "reason": "scheduled"
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "descendant commit: {}",
        String::from_utf8_lossy(&body)
    );

    // The sibling is refused, and the committed world is unchanged.
    upload(&app, &store, &sibling.id).await;
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/servers/{server_id}/checkpoint"),
        Some(serde_json::json!({
            "node_id": host, "epoch": epoch, "snapshot_id": sibling.id, "reason": "manual"
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "divergent branch must not commit"
    );
    assert_eq!(json(&body)["code"], "forked_snapshot");

    let (_, body) = call(&app, "GET", &format!("/v1/servers/{server_id}"), None).await;
    assert_eq!(
        json(&body)["committed_snapshot"],
        child.id.as_str(),
        "the committed world must still be the child snapshot"
    );

    // Keep the manifests alive until here so the compiler does not warn them unused.
    let _ = (root_manifest, child_manifest, sibling_manifest);
}

#[tokio::test]
async fn the_door_issues_a_ticket_only_to_members() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app(tmp.path());

    // A server exists -> its room exists.
    let (_, body) = call(
        &app,
        "POST",
        "/v1/servers",
        Some(serde_json::json!({ "name": "world" })),
    )
    .await;
    let server_id = json(&body)["server_id"].as_str().unwrap().to_string();

    // Fetch the room via the server.
    let (status, body) = call(&app, "GET", &format!("/v1/servers/{server_id}/room"), None).await;
    assert_eq!(status, StatusCode::OK);
    let room_id = json(&body)["room_id"].as_str().unwrap().to_string();
    assert_eq!(json(&body)["members_only"], false, "rooms start open");

    // Open room: anyone may join and gets a verifiable ticket.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/join"),
        Some(serde_json::json!({ "player": "alex" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ticket: nomad_proto::door::DoorTicket =
        serde_json::from_value(json(&body)["ticket"].clone()).expect("ticket deserializes");
    assert_eq!(ticket.player, "alex");
    assert_eq!(ticket.room_id.as_str(), room_id);
    assert!(
        nomad_proto::door::verify_ticket(b"nomadcraft-development-door-secret", &ticket),
        "ticket must verify with the development secret"
    );

    // Lock the room and list a member.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/members"),
        Some(serde_json::json!({ "player": "alex" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/lock"),
        Some(serde_json::json!({ "members_only": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["members_only"], true);

    // The member is still admitted...
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/join"),
        Some(serde_json::json!({ "player": "alex" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // ...but a stranger is refused at the door.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/join"),
        Some(serde_json::json!({ "player": "mallory" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json(&body)["code"], "not_a_member");

    // Empty names are rejected outright.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/rooms/{room_id}/join"),
        Some(serde_json::json!({ "player": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn room_membership_survives_a_control_plane_restart() {
    let tmp = tempfile::tempdir().unwrap();

    let room_id = {
        let app = app(tmp.path());
        let (_, body) = call(
            &app,
            "POST",
            "/v1/servers",
            Some(serde_json::json!({ "name": "world" })),
        )
        .await;
        let server_id = json(&body)["server_id"].as_str().unwrap().to_string();
        let (_, body) = call(&app, "GET", &format!("/v1/servers/{server_id}/room"), None).await;
        let room_id = json(&body)["room_id"].as_str().unwrap().to_string();

        call(
            &app,
            "POST",
            &format!("/v1/rooms/{room_id}/members"),
            Some(serde_json::json!({ "player": "alex" })),
        )
        .await;
        call(
            &app,
            "POST",
            &format!("/v1/rooms/{room_id}/lock"),
            Some(serde_json::json!({ "members_only": true })),
        )
        .await;
        room_id
    };

    // Fresh state opened over the same directory: membership must persist.
    let app = app(tmp.path());
    let (status, body) = call(&app, "GET", &format!("/v1/rooms/{room_id}/members"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["members_only"], true);
    assert_eq!(
        json(&body)["members"],
        serde_json::json!(["alex"]),
        "the member list must survive a restart"
    );
}
