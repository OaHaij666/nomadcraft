//! NomadCraft control plane binary.
//!
//! This is a thin entry point; the decision-making core lives in the library so it
//! can be unit-tested without a network or a database.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use nomad_control_plane::{api, AppState};

#[derive(Parser, Debug)]
#[command(
    name = "nomad-control-plane",
    version,
    about = "NomadCraft control plane"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print build and protocol information, then exit.
    Info,
    /// Run the HTTP API and scheduler.
    Serve {
        /// Address to bind, e.g. 0.0.0.0:8787.
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: String,
        /// Directory for durable state (engine.json + world store).
        #[arg(long, env = "NOMAD_DATA_DIR", default_value = ".nomad/control-plane")]
        data_dir: PathBuf,
    },
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
            println!("nomad-control-plane {}", env!("CARGO_PKG_VERSION"));
            println!("protocol version: {}", nomad_proto::PROTOCOL_VERSION);
        }
        Command::Serve { bind, data_dir } => {
            let state = AppState::open(&data_dir)?;
            let app = api::router(state);
            let listener = tokio::net::TcpListener::bind(&bind).await?;
            tracing::info!(%bind, data_dir = %data_dir.display(), "control plane listening");
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}
