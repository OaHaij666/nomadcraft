//! NomadCraft agent binary.
//!
//! The agent runs on every player's machine. In this MVP its `run` command does the
//! parts that are meaningful today: register this machine with the control plane,
//! then report the assigned identity. Starting an actual Minecraft process is the
//! next milestone and is deliberately left out until the control loop is wired.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use nomad_agent::control::NodeRegistration;
use nomad_agent::{AgentConfig, ControlClient};

#[derive(Parser, Debug)]
#[command(name = "nomad-agent", version, about = "NomadCraft agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print build information, then exit.
    Info,
    /// Register this machine with a control plane and print the assigned id.
    Register {
        #[arg(
            long,
            env = "NOMAD_CONTROL_PLANE",
            default_value = "http://127.0.0.1:8787"
        )]
        control_plane: String,
        #[arg(long, default_value = "nomad-pc")]
        name: String,
        /// Mark this machine as an always-on replica.
        #[arg(long, default_value_t = false)]
        anchor: bool,
    },
    /// Ask to host a server, printing the granted lease.
    Host {
        #[arg(
            long,
            env = "NOMAD_CONTROL_PLANE",
            default_value = "http://127.0.0.1:8787"
        )]
        control_plane: String,
        #[arg(long)]
        server: String,
        /// Restrict hosting to this node id; omit to let the control plane choose.
        #[arg(long)]
        node: Option<String>,
    },
    /// Run the agent loop (registration plus hosting).
    Run {
        #[arg(
            long,
            env = "NOMAD_CONTROL_PLANE",
            default_value = "http://127.0.0.1:8787"
        )]
        control_plane: String,
        #[arg(long, env = "NOMAD_DATA_DIR", default_value = ".nomad/agent")]
        data_dir: PathBuf,
    },
}

fn local_node_registration(name: String, anchor: bool, heap_mb: u32) -> NodeRegistration {
    NodeRegistration {
        name,
        node_id: None,
        public_key: String::new(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_cores: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4),
        memory_mb: (heap_mb * 2) as u64,
        disk_free_bytes: 0,
        uplink_mbps: 20.0,
        hosting_enabled: true,
        anchor,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Info => {
            println!("nomad-agent {}", env!("CARGO_PKG_VERSION"));
            println!("protocol version: {}", nomad_proto::PROTOCOL_VERSION);
        }
        Command::Register {
            control_plane,
            name,
            anchor,
        } => {
            let client = ControlClient::new(control_plane);
            let reg = local_node_registration(name, anchor, 4096);
            let done = client.register(&reg).await?;
            println!("registered as {}", done.node_id);
        }
        Command::Host {
            control_plane,
            server,
            node,
        } => {
            let client = ControlClient::new(control_plane);
            let lease = client.claim_host(&server, node.as_deref()).await?;
            println!(
                "hosting granted: server={} node={} epoch={} restore={:?}",
                lease.server_id, lease.node_id, lease.epoch, lease.restore_snapshot
            );
        }
        Command::Run {
            control_plane,
            data_dir,
        } => {
            let cfg = AgentConfig::new(data_dir);
            let client = ControlClient::new(control_plane);
            let reg = local_node_registration("nomad-pc".into(), cfg.anchor, cfg.heap_mb);
            let done = client.register(&reg).await?;
            tracing::info!(node = %done.node_id, "agent registered");
            println!("agent running as {}", done.node_id);
        }
    }
    Ok(())
}
