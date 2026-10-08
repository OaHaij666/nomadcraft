//! NomadCraft control plane binary.
//!
//! This is a thin entry point; the decision-making core lives in the library so it
//! can be unit-tested without a network or a database.

use clap::{Parser, Subcommand};

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
    /// Run the control plane (HTTP API + scheduler). Not yet implemented.
    Serve {
        /// Address to bind, e.g. 127.0.0.1:8787.
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: String,
    },
}

fn main() -> anyhow::Result<()> {
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
        Command::Serve { bind } => {
            tracing::warn!(%bind, "serve is not implemented yet; use `info` for now");
        }
    }
    Ok(())
}
