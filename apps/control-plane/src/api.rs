//! The control-plane HTTP API.
//!
//! Everything an agent or the dashboard needs, in one place:
//!
//! * **membership** — register a machine, list machines
//! * **hosting** — create a server, claim/release/renew a lease
//! * **durability** — commit checkpoints, upload and download world chunks
//!
//! The handlers are thin: they turn HTTP into engine calls and chunk-store calls,
//! and persist after every mutation. All the safety logic lives in the engine, so
//! this layer has very little to get wrong.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use nomad_proto::door::{sign_ticket, DoorTicket};
use nomad_proto::epoch::Epoch;
use nomad_proto::ids::{NodeId, RoomId, ServerId, SnapshotId};
use nomad_proto::manifest::Manifest;
use nomad_snapshot::{ChunkId, SnapshotStore};

use crate::engine::{Engine, EngineError, SystemClock};
use crate::persist::StateFile;
use crate::scheduler::NodeView;

/// How long a door ticket stays valid. Long enough for the client to connect and
/// authenticate, short enough that a leaked ticket is not a standing key.
const TICKET_TTL_MS: i64 = 60_000;

/// Shared server state.
pub struct AppState {
    pub engine: Mutex<Engine<SystemClock>>,
    pub store: SnapshotStore,
    pub state_file: StateFile,
    /// Secret the relay shares with the control plane, used to sign door tickets.
    ///
    /// Read from `NOMAD_DOOR_SECRET`; when unset a development default is used so a
    /// single-machine demo works out of the box. Deployments must set it, because
    /// the relay and the control plane have to agree on the same value.
    door_secret: Vec<u8>,
}

impl AppState {
    /// Build state rooted at `data_dir`, loading any previous engine state.
    pub fn open(data_dir: impl AsRef<std::path::Path>) -> anyhow::Result<Arc<Self>> {
        let data_dir = data_dir.as_ref();
        let state_file = StateFile::new(data_dir.join("engine.json"));
        let store = SnapshotStore::open(data_dir.join("store"))?;
        let door_secret = door_secret_from_env();

        let mut engine = Engine::new(SystemClock);
        engine.import(state_file.load()?);

        Ok(Arc::new(Self {
            engine: Mutex::new(engine),
            store,
            state_file,
            door_secret,
        }))
    }

    /// Persist the engine. Callers hold the engine lock.
    fn persist(&self, engine: &Engine<SystemClock>) -> anyhow::Result<()> {
        self.state_file.save(&engine.export())
    }
}

/// An error that turns into a JSON body with a sensible status code.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn not_found(what: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", what)
    }

    fn bad_request(what: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", what)
    }
}

impl From<EngineError> for ApiError {
    fn from(e: EngineError) -> Self {
        let (status, code) = match &e {
            EngineError::HostBusy { .. } => (StatusCode::CONFLICT, "host_busy"),
            EngineError::ForkedSnapshot(_) => (StatusCode::CONFLICT, "forked_snapshot"),
            EngineError::StaleEpoch { .. } => (StatusCode::CONFLICT, "stale_epoch"),
            EngineError::NoCandidate => (StatusCode::CONFLICT, "no_candidate"),
            EngineError::NotOnline => (StatusCode::CONFLICT, "node_offline"),
            EngineError::HostingDisabled => (StatusCode::CONFLICT, "hosting_disabled"),
            EngineError::UnknownNode
            | EngineError::UnknownServer(_)
            | EngineError::UnknownSnapshot(_) => (StatusCode::NOT_FOUND, "not_found"),
        };
        ApiError::new(status, code, e.to_string())
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(ErrorBody {
            code: self.code,
            message: self.message,
        });
        (self.status, body).into_response()
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

type ApiResult<T> = Result<Json<T>, ApiError>;

/// Build the router. Kept separate from `serve` so tests can exercise it
/// in-process without binding a socket.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/nodes", get(list_nodes))
        .route("/v1/nodes/register", post(register_node))
        .route("/v1/servers", post(create_server))
        .route("/v1/servers/{id}", get(get_server))
        .route("/v1/servers/{id}/claim", post(claim))
        .route("/v1/servers/{id}/release", post(release))
        .route("/v1/servers/{id}/renew", post(renew))
        .route("/v1/servers/{id}/checkpoint", post(commit_checkpoint))
        .route("/v1/servers/{id}/checkpoints", get(list_checkpoints))
        .route("/v1/servers/{id}/room", get(get_server_room))
        .route("/v1/rooms/{id}/join", post(join_room))
        .route("/v1/rooms/{id}/admit", post(admit_room))
        .route(
            "/v1/rooms/{id}/members",
            get(list_members).post(add_member).delete(remove_member),
        )
        .route("/v1/rooms/{id}/lock", post(set_room_lock))
        .route(
            "/v1/snapshots/{id}/manifest",
            put(put_manifest).get(get_manifest),
        )
        .route(
            "/v1/snapshots/{id}/chunks/{hash}",
            put(put_chunk).get(get_chunk),
        )
        // Custom-defined chunks are up to 4 MiB before compression; leave generous
        // headroom over axum's 2 MiB default so uploads never hit a spurious 413.
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct RegisterNode {
    #[serde(default)]
    node_id: Option<NodeId>,
    name: String,
    #[serde(default)]
    public_key: String,
    #[serde(default = "default_os")]
    os: String,
    #[serde(default = "default_arch")]
    arch: String,
    #[serde(default = "default_cores")]
    cpu_cores: u32,
    #[serde(default)]
    memory_mb: u64,
    #[serde(default)]
    disk_free_bytes: u64,
    #[serde(default)]
    uplink_mbps: f64,
    #[serde(default = "default_true")]
    hosting_enabled: bool,
    #[serde(default)]
    anchor: bool,
}

fn default_os() -> String {
    std::env::consts::OS.to_string()
}
fn default_arch() -> String {
    std::env::consts::ARCH.to_string()
}
fn default_cores() -> u32 {
    4
}
fn default_true() -> bool {
    true
}

#[derive(Serialize)]
struct RegisterNodeResponse {
    node_id: NodeId,
    anchor: bool,
}

async fn register_node(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterNode>,
) -> ApiResult<RegisterNodeResponse> {
    if req.name.trim().is_empty() {
        return Err(ApiError::bad_request("node name must not be empty"));
    }
    let node_id = req.node_id.clone().unwrap_or_else(NodeId::generate);
    let view = NodeView {
        node_id: node_id.clone(),
        online: true,
        hosting_enabled: req.hosting_enabled,
        anchor: req.anchor,
        priority: 0,
        cpu_cores: req.cpu_cores.max(1),
        memory_mb: req.memory_mb,
        disk_free_bytes: req.disk_free_bytes,
        uplink_mbps: req.uplink_mbps,
        user_active: false,
        on_battery: false,
        has_current_snapshot: false,
        uptime_s: 0,
        players_here: 0,
        restore_bytes: 0,
        draining: false,
    };
    let mut engine = state.engine.lock().await;
    engine.upsert_node(view, req.public_key);
    state.persist(&engine)?;
    tracing::info!(%node_id, name = %req.name, os = %req.os, arch = %req.arch, "node registered");
    Ok(Json(RegisterNodeResponse {
        node_id,
        anchor: req.anchor,
    }))
}

#[derive(Serialize)]
struct NodeSummary {
    node_id: NodeId,
    online: bool,
    anchor: bool,
    hosting_enabled: bool,
    cpu_cores: u32,
    memory_mb: u64,
    uplink_mbps: f64,
    draining: bool,
    public_key: String,
}

async fn list_nodes(State(state): State<Arc<AppState>>) -> ApiResult<Vec<NodeSummary>> {
    let engine = state.engine.lock().await;
    let mut nodes: Vec<NodeSummary> = engine
        .nodes()
        .map(|(id, rec)| NodeSummary {
            node_id: id.clone(),
            online: rec.view.online,
            anchor: rec.view.anchor,
            hosting_enabled: rec.view.hosting_enabled,
            cpu_cores: rec.view.cpu_cores,
            memory_mb: rec.view.memory_mb,
            uplink_mbps: rec.view.uplink_mbps,
            draining: rec.view.draining,
            public_key: rec.public_key.clone(),
        })
        .collect();
    nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    Ok(Json(nodes))
}

#[derive(Deserialize)]
struct CreateServer {
    name: String,
    #[serde(default)]
    room_id: Option<RoomId>,
}

#[derive(Serialize)]
struct ServerResponse {
    server_id: ServerId,
    room_id: RoomId,
    epoch: u64,
    host: Option<NodeId>,
    committed_snapshot: Option<SnapshotId>,
}

fn server_response(engine: &Engine<SystemClock>, server_id: &ServerId) -> ServerResponse {
    ServerResponse {
        server_id: server_id.clone(),
        room_id: engine
            .room_of(server_id)
            .cloned()
            .unwrap_or_else(RoomId::generate),
        epoch: engine.epoch(server_id).get(),
        host: engine.active_lease(server_id).map(|l| l.node_id.clone()),
        committed_snapshot: engine.committed_snapshot(server_id).cloned(),
    }
}

async fn create_server(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateServer>,
) -> ApiResult<ServerResponse> {
    if req.name.trim().is_empty() {
        return Err(ApiError::bad_request("server name must not be empty"));
    }
    let room_id = req.room_id.clone().unwrap_or_else(RoomId::generate);
    let server_id = ServerId::generate();
    let mut engine = state.engine.lock().await;
    engine.ensure_server(&server_id, &room_id);
    state.persist(&engine)?;
    Ok(Json(server_response(&engine, &server_id)))
}

async fn get_server(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<ServerResponse> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let engine = state.engine.lock().await;
    if engine.room_of(&server_id).is_none() {
        return Err(ApiError::not_found("no such server"));
    }
    Ok(Json(server_response(&engine, &server_id)))
}

#[derive(Deserialize, Default)]
struct ClaimRequest {
    #[serde(default)]
    node_id: Option<NodeId>,
}

#[derive(Serialize)]
struct LeaseResponse {
    server_id: ServerId,
    node_id: NodeId,
    epoch: u64,
    expires_at_unix_ms: i64,
    restore_snapshot: Option<SnapshotId>,
}

async fn claim(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<ClaimRequest>,
) -> ApiResult<LeaseResponse> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    let lease = engine.claim(&server_id, req.node_id.as_ref())?;
    state.persist(&engine)?;
    tracing::info!(%server_id, node = %lease.node_id, epoch = lease.epoch.get(), "host elected");
    Ok(Json(LeaseResponse {
        server_id: lease.server_id,
        node_id: lease.node_id,
        epoch: lease.epoch.get(),
        expires_at_unix_ms: lease.expires_at_unix_ms,
        restore_snapshot: lease.restore_snapshot,
    }))
}

#[derive(Deserialize)]
struct EpochRequest {
    node_id: NodeId,
    epoch: u64,
    #[serde(default)]
    reason: String,
}

async fn release(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<EpochRequest>,
) -> Result<StatusCode, ApiError> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    engine.release(&server_id, &req.node_id, Epoch::new(req.epoch))?;
    state.persist(&engine)?;
    tracing::info!(%server_id, node = %req.node_id, reason = %req.reason, "host released");
    Ok(StatusCode::NO_CONTENT)
}

async fn renew(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<EpochRequest>,
) -> ApiResult<LeaseResponse> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    let lease = engine.renew(&server_id, &req.node_id, Epoch::new(req.epoch))?;
    state.persist(&engine)?;
    Ok(Json(LeaseResponse {
        server_id: lease.server_id,
        node_id: lease.node_id,
        epoch: lease.epoch.get(),
        expires_at_unix_ms: lease.expires_at_unix_ms,
        restore_snapshot: lease.restore_snapshot,
    }))
}

#[derive(Deserialize)]
struct CommitCheckpoint {
    node_id: NodeId,
    epoch: u64,
    snapshot_id: SnapshotId,
    #[serde(default)]
    reason: String,
}

#[derive(Serialize)]
struct CheckpointResponse {
    server_id: ServerId,
    snapshot_id: SnapshotId,
    committed_snapshot: SnapshotId,
    epoch: u64,
}

/// Record that a host finished uploading a snapshot and it is now safe.
///
/// This is the durability hinge: only snapshots announced here become the
/// restore target for the next host.
async fn commit_checkpoint(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<CommitCheckpoint>,
) -> ApiResult<CheckpointResponse> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    engine.check_epoch(&server_id, Epoch::new(req.epoch))?;

    // The chunk store must actually hold the snapshot before we call it safe.
    // A snapshot with no manifest (or missing chunks) is simply not committable,
    // which is a conflict, never an internal error.
    let complete = nomad_snapshot::is_complete(&state.store, &req.snapshot_id).unwrap_or(false);
    if !complete {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "incomplete_snapshot",
            format!(
                "snapshot {} is missing its manifest or chunks",
                req.snapshot_id
            ),
        ));
    }

    // Anti-fork. A host is only allowed to commit a world that descends from the
    // one it was handed. A snapshot built from a stale copy would not chain back to
    // the committed world; accepting it would silently discard everyone else's
    // progress, so it is refused instead.
    //
    // The very first snapshot of a server has no committed ancestor and is always
    // allowed — that is how a world comes into existence.
    if let Some(previous) = engine.committed_snapshot(&server_id).cloned() {
        let descends = nomad_snapshot::descends_from(&state.store, &req.snapshot_id, &previous)
            .unwrap_or(false);
        if !descends {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "forked_snapshot",
                format!(
                    "snapshot {} does not descend from committed {}",
                    req.snapshot_id, previous
                ),
            ));
        }
    }

    engine.record_committed(&server_id, req.snapshot_id.clone())?;
    state.persist(&engine)?;
    tracing::info!(
        %server_id,
        node = %req.node_id,
        snapshot = %req.snapshot_id,
        epoch = req.epoch,
        reason = %req.reason,
        "checkpoint committed"
    );
    Ok(Json(CheckpointResponse {
        server_id,
        snapshot_id: req.snapshot_id.clone(),
        committed_snapshot: req.snapshot_id,
        epoch: req.epoch,
    }))
}

#[derive(Serialize)]
struct CheckpointSummary {
    snapshot_id: SnapshotId,
    file_count: usize,
    total_bytes: u64,
    is_committed: bool,
}

async fn list_checkpoints(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Vec<CheckpointSummary>> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let committed = {
        let engine = state.engine.lock().await;
        if engine.room_of(&server_id).is_none() {
            return Err(ApiError::not_found("no such server"));
        }
        engine.committed_snapshot(&server_id).cloned()
    };

    let mut out = Vec::new();
    for snap in state.store.list_snapshots()? {
        let manifest = state.store.manifest(&snap)?;
        let total: u64 = manifest.files.iter().map(|f| f.size).sum();
        out.push(CheckpointSummary {
            snapshot_id: snap.clone(),
            file_count: manifest.files.iter().filter(|f| f.size > 0).count(),
            total_bytes: total,
            is_committed: committed.as_ref() == Some(&snap),
        });
    }
    Ok(Json(out))
}

#[derive(Serialize)]
struct ManifestResponse {
    snapshot_id: SnapshotId,
    manifest: Manifest,
    missing_chunks: Vec<String>,
}

/// Download a snapshot's manifest, plus which chunks the caller must still send.
async fn get_manifest(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<ManifestResponse> {
    let snapshot_id = SnapshotId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let manifest = state
        .store
        .manifest(&snapshot_id)
        .map_err(|_| ApiError::not_found(format!("no manifest for {snapshot_id}")))?;
    let missing = nomad_snapshot::missing_chunks_for(&state.store, &manifest);
    Ok(Json(ManifestResponse {
        snapshot_id,
        manifest,
        missing_chunks: missing
            .into_iter()
            .map(|c| c.as_str().to_string())
            .collect(),
    }))
}

/// Upload a snapshot manifest. The id in the path must match the manifest's own
/// digest, so a manifest can never be stored under a false name.
async fn put_manifest(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let claimed = SnapshotId::parse(id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let manifest: Manifest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::bad_request(format!("invalid manifest: {e}")))?;
    let actual = manifest
        .digest_id()
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    if actual != claimed {
        return Err(ApiError::bad_request(format!(
            "manifest digest {actual} does not match path {claimed}"
        )));
    }
    state.store.put_manifest(&manifest)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Download one chunk in compressed transfer form.
async fn get_chunk(
    State(state): State<Arc<AppState>>,
    AxumPath((_id, hash)): AxumPath<(String, String)>,
) -> Result<Vec<u8>, ApiError> {
    let chunk = ChunkId::from_hex(hash);
    let bytes = state
        .store
        .chunk_compressed(&chunk)
        .map_err(|_| ApiError::not_found(format!("no chunk {chunk}")))?;
    Ok(bytes)
}

/// Upload one chunk. The receiver verifies its plaintext hash before storing, so
/// a corrupt or hostile upload is rejected rather than written.
async fn put_chunk(
    State(state): State<Arc<AppState>>,
    AxumPath((_id, hash)): AxumPath<(String, String)>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let chunk = ChunkId::from_hex(hash);
    state
        .store
        .import_chunk(&chunk, &body)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The shared door secret. A deployment must set `NOMAD_DOOR_SECRET` so the relay
/// and the control plane agree; the fallback keeps a local demo working.
fn door_secret_from_env() -> Vec<u8> {
    match std::env::var("NOMAD_DOOR_SECRET") {
        Ok(v) if !v.is_empty() => v.into_bytes(),
        _ => b"nomadcraft-development-door-secret".to_vec(),
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct RoomResponse {
    room_id: RoomId,
    members: Vec<String>,
    members_only: bool,
}

fn room_response(engine: &Engine<SystemClock>, room_id: &RoomId) -> RoomResponse {
    let rec = engine.room(room_id).cloned().unwrap_or_default();
    RoomResponse {
        room_id: room_id.clone(),
        members: rec.members,
        members_only: rec.members_only,
    }
}

/// A server's room, plus its membership list.
async fn get_server_room(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<RoomResponse> {
    let server_id = ServerId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let engine = state.engine.lock().await;
    let room_id = engine
        .room_of(&server_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("no such server"))?;
    Ok(Json(room_response(&engine, &room_id)))
}

#[derive(Deserialize)]
struct JoinRoom {
    player: String,
}

#[derive(Serialize)]
struct JoinResponse {
    ticket: DoorTicket,
    /// Seconds until the ticket expires, so a client can refresh in time.
    expires_in_s: i64,
}

/// Ask to enter a room. This is the door.
///
/// The player may only be admitted if the room lists them (once the room is locked).
/// On success we mint a short-lived signed ticket; the relay verifies it with the
/// shared secret, so a raw client that skipped this call cannot get in.
async fn join_room(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<JoinRoom>,
) -> ApiResult<JoinResponse> {
    if req.player.trim().is_empty() {
        return Err(ApiError::bad_request("player name must not be empty"));
    }
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;

    let engine = state.engine.lock().await;
    let Some(rec) = engine.room(&room_id) else {
        return Err(ApiError::not_found("no such room"));
    };
    if !rec.admits(&req.player) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "not_a_member",
            format!("{} is not a member of this room", req.player),
        ));
    }

    let issued = now_ms();
    let mut ticket = DoorTicket {
        room_id,
        player: req.player.clone(),
        issued_at_unix_ms: issued,
        expires_at_unix_ms: issued + TICKET_TTL_MS,
        nonce: uuid_like_nonce(),
        signature: String::new(),
    };
    ticket.signature = sign_ticket(&state.door_secret, &ticket);
    Ok(Json(JoinResponse {
        ticket,
        expires_in_s: TICKET_TTL_MS / 1000,
    }))
}

/// Authorize one connection. The relay calls this at the door.
///
/// This is the same membership rule as `join_room`, exposed for the relay rather
/// than the player: the relay has no database and must not decide policy, so it
/// asks the control plane for a yes/no and refuses the connection on anything else.
#[derive(Deserialize)]
struct AdmitRoom {
    player: String,
}

#[derive(Serialize)]
struct AdmitResponse {
    admitted: bool,
    room_id: RoomId,
    player: String,
}

async fn admit_room(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<AdmitRoom>,
) -> ApiResult<AdmitResponse> {
    if req.player.trim().is_empty() {
        return Err(ApiError::bad_request("player name must not be empty"));
    }
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let engine = state.engine.lock().await;
    let Some(rec) = engine.room(&room_id) else {
        return Err(ApiError::not_found("no such room"));
    };
    if !rec.admits(&req.player) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "not_a_member",
            format!("{} is not a member of this room", req.player),
        ));
    }
    tracing::info!(%room_id, player = %req.player, "door admitted a player");
    Ok(Json(AdmitResponse {
        admitted: true,
        room_id,
        player: req.player,
    }))
}

/// A per-ticket random nonce, so two otherwise-identical tickets never share a
/// signature and the relay has something to dedupe on.
fn uuid_like_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<RoomResponse> {
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let engine = state.engine.lock().await;
    if engine.room(&room_id).is_none() {
        return Err(ApiError::not_found("no such room"));
    }
    Ok(Json(room_response(&engine, &room_id)))
}

#[derive(Deserialize)]
struct MemberChange {
    player: String,
}

async fn add_member(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<MemberChange>,
) -> ApiResult<RoomResponse> {
    if req.player.trim().is_empty() {
        return Err(ApiError::bad_request("player name must not be empty"));
    }
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    engine.add_member(&room_id, &req.player);
    state.persist(&engine)?;
    Ok(Json(room_response(&engine, &room_id)))
}

async fn remove_member(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<MemberChange>,
) -> ApiResult<RoomResponse> {
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    engine.remove_member(&room_id, &req.player);
    state.persist(&engine)?;
    Ok(Json(room_response(&engine, &room_id)))
}

#[derive(Deserialize)]
struct RoomLock {
    members_only: bool,
}

/// Turn the door on or off. A room starts open so it is easy to set up; the owner
/// locks it once everyone is listed.
async fn set_room_lock(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<RoomLock>,
) -> ApiResult<RoomResponse> {
    let room_id = RoomId::parse(id).map_err(|e| ApiError::not_found(e.to_string()))?;
    let mut engine = state.engine.lock().await;
    engine.ensure_server_room(&room_id);
    engine.set_members_only(&room_id, req.members_only);
    state.persist(&engine)?;
    Ok(Json(room_response(&engine, &room_id)))
}
