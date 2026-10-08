//! The one packet we care about: the client handshake.

use std::io::Read;

/// Errors while reading the opening bytes of a connection.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("varint is too long (more than 5 bytes)")]
    VarIntTooLong,
    #[error("handshake packet is unreasonably large")]
    PacketTooLarge,
    #[error("not a Minecraft handshake: packet id {0}")]
    NotHandshake(i32),
    #[error("unknown intent id: {0}")]
    UnknownIntent(i32),
    #[error("string is not valid UTF-8")]
    BadUtf8,
    #[error("not enough bytes yet")]
    NeedMore,
}

/// A Minecraft variable-length integer (LEB128, little-endian groups of 7 bits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VarInt(pub i32);

impl VarInt {
    /// The largest number of bytes a varint may occupy.
    pub const MAX_BYTES: usize = 5;
}

/// Read a VarInt from a reader, one byte at a time.
///
/// Reading a byte at a time matters: the socket may already hold game bytes after
/// the handshake, and a buffered read would swallow them.
pub fn read_varint<R: Read>(reader: &mut R) -> Result<VarInt, ProtocolError> {
    let mut result: i32 = 0;
    let mut shift = 0;
    for _ in 0..VarInt::MAX_BYTES {
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)?;
        let b = byte[0];
        result |= ((b & 0x7f) as i32) << shift;
        if b & 0x80 == 0 {
            return Ok(VarInt(result));
        }
        shift += 7;
    }
    Err(ProtocolError::VarIntTooLong)
}

fn read_varint_string<R: Read>(reader: &mut R) -> Result<String, ProtocolError> {
    let len = read_varint(reader)?.0;
    if len < 0 || len as usize > 4096 {
        return Err(ProtocolError::PacketTooLarge);
    }
    let mut bytes = vec![0u8; len as usize];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|_| ProtocolError::BadUtf8)
}

/// What the client intends to do on this connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    /// A server-list ping: read a status response, then disconnect.
    Status,
    /// A normal login.
    Login,
    /// A transfer from another server (Minecraft 1.20.5+).
    Transfer,
}

impl Intent {
    /// Convert the raw intent id from the handshake.
    pub fn from_id(id: i32) -> Result<Self, ProtocolError> {
        match id {
            1 => Ok(Intent::Status),
            2 => Ok(Intent::Login),
            3 => Ok(Intent::Transfer),
            other => Err(ProtocolError::UnknownIntent(other)),
        }
    }

    /// Whether this intent is a login of either kind.
    pub fn is_login(self) -> bool {
        matches!(self, Intent::Login | Intent::Transfer)
    }
}

/// The parsed opening handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    /// Protocol version the client speaks.
    pub protocol_version: i32,
    /// The address the player typed, e.g. "friends.example.com".
    ///
    /// This is how a single public port serves many rooms: the room is the
    /// hostname, exactly as a normal Minecraft network would route it.
    pub server_address: String,
    /// The port the client used.
    pub server_port: u16,
    /// What the client wants to do.
    pub intent: Intent,
}

impl Handshake {
    /// The bare hostname with any `host:port` suffix removed, lowercased.
    pub fn hostname(&self) -> String {
        let host = self
            .server_address
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(&self.server_address);
        host.trim_end_matches('.').to_ascii_lowercase()
    }
}

/// Read the opening handshake from a raw stream.
///
/// On success the reader is positioned exactly after the handshake packet, so any
/// following bytes remain untouched.
pub fn read_handshake<R: Read>(reader: &mut R) -> Result<Handshake, ProtocolError> {
    let packet_len = read_varint(reader)?.0;
    if !(0..=4096).contains(&packet_len) {
        return Err(ProtocolError::PacketTooLarge);
    }

    let packet_id = read_varint(reader)?.0;
    if packet_id != 0x00 {
        return Err(ProtocolError::NotHandshake(packet_id));
    }
    let protocol_version = read_varint(reader)?.0;
    let server_address = read_varint_string(reader)?;
    let mut port = [0u8; 2];
    reader.read_exact(&mut port)?;
    let server_port = u16::from_be_bytes(port);
    let intent = Intent::from_id(read_varint(reader)?.0)?;

    Ok(Handshake {
        protocol_version,
        server_address,
        server_port,
        intent,
    })
}

/// Try to parse a handshake from a byte slice.
///
/// Returns `Ok(Some((handshake, consumed)))` when a full handshake is present,
/// `Ok(None)` when more bytes are still needed, and an error when the bytes cannot
/// be a handshake. `consumed` is exactly the number of bytes the handshake occupied,
/// which lets a caller replay precisely those bytes to a backend.
pub fn try_read_handshake(buf: &[u8]) -> Result<Option<(Handshake, usize)>, ProtocolError> {
    let mut cursor = std::io::Cursor::new(buf);
    match read_handshake(&mut cursor) {
        Ok(hs) => Ok(Some((hs, cursor.position() as usize))),
        Err(ProtocolError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

/// Append a VarInt to a buffer.
pub fn write_varint(out: &mut Vec<u8>, mut value: i32) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value = ((value as u32) >> 7) as i32;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

/// Encode a packet: length prefix, packet id, then the body bytes.
///
/// Minecraft frames every packet as `[length varint][packet id varint][body]`.
pub fn encode_packet(packet_id: i32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(body.len() + 5);
    write_varint(&mut inner, packet_id);
    inner.extend_from_slice(body);
    let mut out = Vec::with_capacity(inner.len() + 5);
    write_varint(&mut out, inner.len() as i32);
    out.extend_from_slice(&inner);
    out
}

/// Encode a String field: a length varint followed by UTF-8 bytes.
pub fn encode_string(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 5);
    write_varint(&mut out, value.len() as i32);
    out.extend_from_slice(value.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn write_varint(out: &mut Vec<u8>, mut value: i32) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value = ((value as u32) >> 7) as i32;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn write_string(out: &mut Vec<u8>, s: &str) {
        write_varint(out, s.len() as i32);
        out.extend_from_slice(s.as_bytes());
    }

    fn handshake_bytes(protocol: i32, addr: &str, port: u16, intent: i32) -> Vec<u8> {
        let mut body = Vec::new();
        write_varint(&mut body, 0x00);
        write_varint(&mut body, protocol);
        write_string(&mut body, addr);
        body.extend_from_slice(&port.to_be_bytes());
        write_varint(&mut body, intent);
        let mut out = Vec::new();
        write_varint(&mut out, body.len() as i32);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn reads_a_status_handshake() {
        let bytes = handshake_bytes(767, "friends.example.com", 25565, 1);
        let hs = read_handshake(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(hs.protocol_version, 767);
        assert_eq!(hs.server_address, "friends.example.com");
        assert_eq!(hs.server_port, 25565);
        assert_eq!(hs.intent, Intent::Status);
        assert_eq!(hs.hostname(), "friends.example.com");
    }

    #[test]
    fn reads_a_login_handshake_and_strips_the_port() {
        let bytes = handshake_bytes(767, "smp.example.com:25565", 25565, 2);
        let hs = read_handshake(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(hs.intent, Intent::Login);
        assert_eq!(hs.hostname(), "smp.example.com");
    }

    #[test]
    fn reads_a_transfer_intent() {
        let bytes = handshake_bytes(767, "h", 25565, 3);
        let hs = read_handshake(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(hs.intent, Intent::Transfer);
        assert!(hs.intent.is_login());
    }

    #[test]
    fn rejects_a_bad_packet_id() {
        let mut body = Vec::new();
        write_varint(&mut body, 0x42);
        let mut bytes = Vec::new();
        write_varint(&mut bytes, body.len() as i32);
        bytes.extend_from_slice(&body);
        assert!(matches!(
            read_handshake(&mut Cursor::new(bytes)),
            Err(ProtocolError::NotHandshake(0x42))
        ));
    }

    #[test]
    fn rejects_an_unknown_intent() {
        let bytes = handshake_bytes(767, "h", 25565, 9);
        assert!(matches!(
            read_handshake(&mut Cursor::new(bytes)),
            Err(ProtocolError::UnknownIntent(9))
        ));
    }

    #[test]
    fn varint_roundtrips_representative_values() {
        for v in [0, 1, 127, 128, 255, 2097151, 2147483647] {
            let mut buf = Vec::new();
            write_varint(&mut buf, v);
            assert_eq!(read_varint(&mut Cursor::new(buf)).unwrap().0, v);
        }
    }

    #[test]
    fn encoded_packets_roundtrip_through_the_parser() {
        // A status handshake built by the encoder must parse identically.
        let mut body = Vec::new();
        write_varint(&mut body, 0x00);
        write_varint(&mut body, 767);
        body.extend_from_slice(&encode_string("room.example.com"));
        body.extend_from_slice(&25565u16.to_be_bytes());
        write_varint(&mut body, 1);
        let packet = encode_packet(body[0] as i32, &body[1..]);
        let (hs, consumed) = try_read_handshake(&packet).unwrap().unwrap();
        assert_eq!(hs.hostname(), "room.example.com");
        assert_eq!(consumed, packet.len());
    }

    #[test]
    fn try_read_reports_need_more_until_complete() {
        let full = handshake_bytes(767, "room.example.com", 25565, 2);
        // A prefix of a valid handshake is "need more", never an error.
        for cut in 0..full.len() {
            match try_read_handshake(&full[..cut]).unwrap() {
                None => {}
                Some(_) => panic!("prefix of length {cut} should not parse yet"),
            }
        }
        let (hs, consumed) = try_read_handshake(&full).unwrap().unwrap();
        assert_eq!(hs.hostname(), "room.example.com");
        assert_eq!(
            consumed,
            full.len(),
            "consumed must equal the handshake length"
        );
    }

    #[test]
    fn try_read_stops_exactly_at_the_handshake() {
        let mut bytes = handshake_bytes(767, "h", 25565, 2);
        bytes.extend_from_slice(b"GAME BYTES THAT MUST NOT BE CONSUMED");
        let (hs, consumed) = try_read_handshake(&bytes).unwrap().unwrap();
        assert_eq!(hs.intent, Intent::Login);
        assert_eq!(&bytes[consumed..], b"GAME BYTES THAT MUST NOT BE CONSUMED");
    }

    #[test]
    fn rejects_an_overlong_varint() {
        let bytes = vec![0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        assert!(matches!(
            read_varint(&mut Cursor::new(bytes)),
            Err(ProtocolError::VarIntTooLong)
        ));
    }
}
