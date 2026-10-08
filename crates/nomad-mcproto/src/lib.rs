//! A deliberately tiny Minecraft Java protocol reader.
//!
//! NomadCraft's public node must look like an ordinary Minecraft server to the
//! client: the server list should show a MOTD and a player count, and a real
//! session must connect without the player noticing anything unusual. But once the
//! game starts, every byte has to be forwarded untouched to whichever machine is
//! hosting.
//!
//! Those two goals pull in opposite directions, so we draw the line precisely:
//!
//! * **Parse exactly one packet.** The very first thing a client sends is a
//!   *Handshake*, which carries the protocol version, the address the player typed,
//!   and an intent (status ping, or login/transfer). That single packet tells us
//!   which room the player wants and what they are trying to do.
//! * **Never parse the game.** After the handshake we either answer the status ping
//!   ourselves (so the list looks alive even when no host is up) or hand the raw
//!   stream to the tunnel. We do not decode chat, movement, or anything else.
//!
//! This module contains no I/O beyond reading from the socket, so the fiddly varint
//! handling is unit-tested without a network.

pub mod packet;
pub mod status;

pub use packet::{
    encode_packet, encode_string, read_handshake, read_varint, try_read_handshake, write_varint,
    Handshake, Intent, ProtocolError, VarInt,
};
pub use status::{status_json, StatusDescription, StatusPlayers, StatusResponse, StatusVersion};
