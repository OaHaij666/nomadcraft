//! NomadCraft relay binary.
//!
//! One public port serves every room; the room is chosen by the hostname the player
//! connects with. Hosts dial the tunnel port and announce which room they serve.

use std::sync::Arc;

use clap::Parser;
use nomad_relay::{Registry, RoomRoute};

#[derive(Parser, Debug)]
#[command(
    name = "nomad-relay",
    version,
    about = "NomadCraft relay: routes players to the current host"
)]
struct Cli {
    /// Address players connect to.
    #[arg(long, default_value = "0.0.0.0:25565")]
    public: String,
    /// Address host machines dial out to.
    #[arg(long, default_value = "0.0.0.0:25566")]
    tunnel: String,
    /// A room to serve, as `hostname=room_id`. Repeat for many rooms.
    ///
    /// Example: `--room friends.example.com=friends --room smp.example.com=smp`
    #[arg(long = "room", value_parser = parse_room)]
    rooms: Vec<(String, String)>,
}

fn parse_room(raw: &str) -> Result<(String, String), String> {
    let (host, room) = raw
        .split_once('=')
        .ok_or_else(|| format!("expected hostname=room_id, got {raw:?}"))?;
    if host.is_empty() || room.is_empty() {
        return Err(format!("both hostname and room id are required in {raw:?}"));
    }
    Ok((host.to_ascii_lowercase(), room.to_string()))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();

    if cli.rooms.is_empty() {
        anyhow::bail!("at least one --room hostname=room_id is required");
    }

    let routes: Vec<RoomRoute> = cli
        .rooms
        .iter()
        .map(|(host, room)| RoomRoute {
            room_id: host.clone(),
            motd_offline: format!("NomadCraft :: {room} :: 世界休眠中 / asleep"),
            motd_online: format!("NomadCraft :: {room} :: 在线 / live"),
            version_name: "1.21.4".to_string(),
            max_players: 20,
            registry: Registry::new(),
        })
        .collect();

    let _ = Arc::new(());
    nomad_relay::run_rooms(&cli.public, &cli.tunnel, routes).await
}
