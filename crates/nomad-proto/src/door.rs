//! Door tickets: the proof a player was let in *before* reaching the relay.
//!
//! The relay only routes traffic; it must not be the thing that decides who may
//! play. Joining a room goes through the control plane, which stamps a signed,
//! short-lived ticket for the player. The relay verifies that ticket with the
//! shared secret, which stops anyone from pointing a raw Minecraft client at the
//! relay and forking the save behind the group's back.

use serde::{Deserialize, Serialize};

use crate::ids::RoomId;

/// Domain separator mixed into every ticket so these signatures can never be
/// confused with any other BLAKE3 keyed hash we compute later.
const DOMAIN: &[u8] = b"nomadcraft-door-v1";

/// A signed, time-bounded permission for one player to enter one room.
///
/// The signature covers every other field, so a client cannot extend its own
/// expiry, rename itself, or wander into another room by editing the payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoorTicket {
    /// Room the player was granted access to.
    pub room_id: RoomId,
    /// Player name presented when joining the room.
    pub player: String,
    /// When the control plane minted the ticket (Unix ms).
    pub issued_at_unix_ms: i64,
    /// When the ticket stops being accepted (Unix ms).
    pub expires_at_unix_ms: i64,
    /// Random per-ticket value; keeps two identical requests from sharing a
    /// signature and gives the relay something to dedupe on.
    #[serde(default)]
    pub nonce: String,
    /// Lowercase hex BLAKE3 keyed hash over the canonical encoding.
    #[serde(default)]
    pub signature: String,
}

/// Canonical encoding of everything a ticket's signature must cover.
///
/// Length-prefixed fields make the encoding injective: `("ab", "c")` and
/// `("a", "bc")` produce different bytes, so field boundaries can never be
/// shifted to forge an equivalent payload.
pub fn ticket_bytes(
    room_id: &RoomId,
    player: &str,
    issued_at_unix_ms: i64,
    expires_at_unix_ms: i64,
    nonce: &str,
) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(DOMAIN.len() + 16 + room_id.as_str().len() + player.len() + nonce.len());
    out.extend_from_slice(DOMAIN);
    write_field(&mut out, room_id.as_str().as_bytes());
    write_field(&mut out, player.as_bytes());
    out.extend_from_slice(&issued_at_unix_ms.to_le_bytes());
    out.extend_from_slice(&expires_at_unix_ms.to_le_bytes());
    write_field(&mut out, nonce.as_bytes());
    out
}

/// Append a u32 little-endian length followed by the raw bytes.
fn write_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

/// Sign a ticket, returning the lowercase hex signature to store in it.
///
/// The control plane holds `secret`; players never see it, so a ticket is proof
/// of the control plane's blessing and nothing more.
pub fn sign_ticket(secret: &[u8], ticket: &DoorTicket) -> String {
    let bytes = ticket_bytes(
        &ticket.room_id,
        &ticket.player,
        ticket.issued_at_unix_ms,
        ticket.expires_at_unix_ms,
        &ticket.nonce,
    );
    let key = secret_key(secret);
    let hash = blake3::keyed_hash(&key, &bytes);
    hex_encode(hash.as_bytes())
}

/// Verify a ticket's signature, field sanity, and time ordering.
///
/// Returns false for malformed tickets rather than erroring, because the caller
/// is a network gate that just wants a yes/no answer.
pub fn verify_ticket(secret: &[u8], ticket: &DoorTicket) -> bool {
    if ticket.room_id.as_str().is_empty() || ticket.player.is_empty() || ticket.nonce.is_empty() {
        return false;
    }
    if ticket.expires_at_unix_ms <= ticket.issued_at_unix_ms {
        return false;
    }
    let expected = sign_ticket(secret, ticket);
    constant_time_eq(expected.as_bytes(), ticket.signature.as_bytes())
}

/// True when `now` falls inside the ticket's half-open validity window.
///
/// A separate check from [`verify_ticket`] so the control plane can mint a
/// ticket early and the relay can still make the freshness decision itself.
pub fn ticket_is_fresh(ticket: &DoorTicket, now_unix_ms: i64) -> bool {
    ticket.issued_at_unix_ms <= now_unix_ms && now_unix_ms < ticket.expires_at_unix_ms
}

/// Fold an arbitrary-length secret into the fixed 32-byte key BLAKE3 wants.
fn secret_key(secret: &[u8]) -> [u8; 32] {
    let digest = blake3::hash(secret);
    let mut key = [0u8; 32];
    key.copy_from_slice(digest.as_bytes());
    key
}

/// Compare two byte slices without early exit, so timing leaks no prefix info.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Lowercase hex encoding, to avoid pulling in an extra dependency for it.
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DoorTicket {
        let ticket = DoorTicket {
            room_id: RoomId::from_raw("room_test"),
            player: "Steve".to_string(),
            issued_at_unix_ms: 1_000,
            expires_at_unix_ms: 2_000,
            nonce: "nonce-abc".to_string(),
            signature: String::new(),
        };
        let sig = sign_ticket(b"secret", &ticket);
        DoorTicket {
            signature: sig,
            ..ticket
        }
    }

    #[test]
    fn sign_verify_roundtrip() {
        let ticket = sample();
        assert!(verify_ticket(b"secret", &ticket));
    }

    #[test]
    fn tampered_player_fails() {
        let mut ticket = sample();
        ticket.player = "Alex".to_string();
        assert!(!verify_ticket(b"secret", &ticket));
    }

    #[test]
    fn tampered_room_fails() {
        let mut ticket = sample();
        ticket.room_id = RoomId::from_raw("room_other");
        assert!(!verify_ticket(b"secret", &ticket));
    }

    #[test]
    fn tampered_expiry_fails() {
        let mut ticket = sample();
        ticket.expires_at_unix_ms += 1;
        assert!(!verify_ticket(b"secret", &ticket));
    }

    #[test]
    fn wrong_secret_fails() {
        let ticket = sample();
        assert!(!verify_ticket(b"other-secret", &ticket));
    }

    #[test]
    fn expiry_before_issue_is_invalid() {
        let mut ticket = sample();
        ticket.expires_at_unix_ms = ticket.issued_at_unix_ms;
        ticket.signature = sign_ticket(b"secret", &ticket);
        assert!(!verify_ticket(b"secret", &ticket));
    }

    #[test]
    fn freshness_window_is_half_open() {
        let ticket = sample();
        assert!(ticket_is_fresh(&ticket, 1_000));
        assert!(ticket_is_fresh(&ticket, 1_999));
        assert!(!ticket_is_fresh(&ticket, 2_000));
        assert!(!ticket_is_fresh(&ticket, 999));
    }

    #[test]
    fn canonical_encoding_is_injective() {
        let a = ticket_bytes(&RoomId::from_raw("room_a"), "ab", 1, 2, "c");
        let b = ticket_bytes(&RoomId::from_raw("room_a"), "a", 1, 2, "bc");
        assert_ne!(a, b);
    }

    #[test]
    fn empty_fields_are_rejected() {
        let mut ticket = sample();
        ticket.player.clear();
        ticket.signature = sign_ticket(b"secret", &ticket);
        assert!(!verify_ticket(b"secret", &ticket));

        let mut ticket = sample();
        ticket.nonce.clear();
        ticket.signature = sign_ticket(b"secret", &ticket);
        assert!(!verify_ticket(b"secret", &ticket));

        let mut ticket = sample();
        ticket.room_id = RoomId::from_raw("");
        ticket.signature = sign_ticket(b"secret", &ticket);
        assert!(!verify_ticket(b"secret", &ticket));
    }
}
