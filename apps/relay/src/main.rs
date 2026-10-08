//! NomadCraft relay binary.

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "nomad-relay",
    version,
    about = "NomadCraft relay: forwards game traffic to the current host"
)]
struct Cli {
    /// Address players connect to.
    #[arg(long, default_value = "0.0.0.0:25565")]
    public: String,
    /// Address host machines dial out to.
    #[arg(long, default_value = "0.0.0.0:25566")]
    tunnel: String,
    /// Room this relay serves.
    #[arg(long, default_value = "room_default")]
    room: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();
    nomad_relay::run(&cli.public, &cli.tunnel, cli.room).await
}
