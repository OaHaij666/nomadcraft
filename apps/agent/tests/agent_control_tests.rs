//! Agent <-> control-plane integration test.
//!
//! Spins up a real control plane on a random local port and drives the agent's HTTP
//! client against it. This is the check that the two halves actually agree on the
//! wire, not just in theory.

use std::time::Duration;

use nomad_agent::control::NodeRegistration;
use nomad_agent::ControlClient;
use nomad_control_plane::api;

/// Bind a control plane on an ephemeral port and return its base URL.
async fn start_control_plane(dir: &std::path::Path) -> String {
    let state = api::AppState::open(dir).unwrap();
    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    // Give the listener a moment to be ready.
    tokio::time::sleep(Duration::from_millis(50)).await;
    format!("http://{addr}")
}

fn registration(name: &str, cores: u32) -> NodeRegistration {
    NodeRegistration {
        name: name.into(),
        node_id: None,
        public_key: "pk_test".into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        cpu_cores: cores,
        memory_mb: 16384,
        disk_free_bytes: 100 * 1024 * 1024 * 1024,
        uplink_mbps: 50.0,
        hosting_enabled: true,
        anchor: false,
    }
}

async fn wait_for_health(base: &str) {
    let client = ControlClient::new(base);
    for _ in 0..100 {
        // A register call doubles as a liveness probe; ignore its result.
        if client.register(&registration("probe", 1)).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("control plane never became reachable at {base}");
}

#[tokio::test]
async fn agent_registers_and_wins_a_lease_over_real_http() {
    let tmp = tempfile::tempdir().unwrap();
    let base = start_control_plane(tmp.path()).await;
    wait_for_health(&base).await;

    let client = ControlClient::new(&base);

    // Two machines register; the stronger one should be elected.
    let weak = client.register(&registration("weak", 4)).await.unwrap();
    let strong = client.register(&registration("strong", 16)).await.unwrap();
    assert!(weak.node_id.starts_with("node_"));
    assert!(strong.node_id.starts_with("node_"));
    assert_ne!(weak.node_id, strong.node_id);

    // Create a server and let the control plane choose the host.
    let server = client.create_server("friends").await.unwrap();
    assert_eq!(server.epoch, 0);
    assert!(server.host.is_none());

    let lease = client.claim_host(&server.server_id, None).await.unwrap();
    assert_eq!(lease.epoch, 1);
    assert_eq!(
        lease.node_id, strong.node_id,
        "the 16-core machine should host"
    );

    // The server now reports the host.
    let now = client.get_server(&server.server_id).await.unwrap();
    assert_eq!(now.host.as_deref(), Some(strong.node_id.as_str()));

    // A live lease cannot be claimed again.
    let err = client
        .claim_host(&server.server_id, None)
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        nomad_agent::ControlError::Refused { status: 409, .. }
    ));
}

#[tokio::test]
async fn releasing_and_reclaiming_advances_the_epoch() {
    let tmp = tempfile::tempdir().unwrap();
    let base = start_control_plane(tmp.path()).await;
    wait_for_health(&base).await;

    let client = ControlClient::new(&base);
    let a = client.register(&registration("a", 16)).await.unwrap();
    let _b = client.register(&registration("b", 4)).await.unwrap();
    let server = client.create_server("room").await.unwrap();

    let first = client.claim_host(&server.server_id, None).await.unwrap();
    assert_eq!(first.node_id, a.node_id);

    client
        .release_host(&server.server_id, &first.node_id, first.epoch, "user_quit")
        .await
        .unwrap();

    let second = client.claim_host(&server.server_id, None).await.unwrap();
    assert_eq!(second.epoch, 2, "handover bumps the epoch");
    assert_ne!(second.node_id, first.node_id, "a quitter is not re-elected");
}

#[tokio::test]
async fn renewing_keeps_the_same_epoch() {
    let tmp = tempfile::tempdir().unwrap();
    let base = start_control_plane(tmp.path()).await;
    wait_for_health(&base).await;

    let client = ControlClient::new(&base);
    let node = client.register(&registration("only", 8)).await.unwrap();
    let server = client.create_server("solo").await.unwrap();
    let lease = client.claim_host(&server.server_id, None).await.unwrap();
    assert_eq!(lease.node_id, node.node_id);

    let renewed = client
        .renew_lease(&server.server_id, &lease.node_id, lease.epoch)
        .await
        .unwrap();
    assert_eq!(renewed.epoch, lease.epoch);
    assert!(renewed.expires_at_unix_ms >= lease.expires_at_unix_ms);
}
