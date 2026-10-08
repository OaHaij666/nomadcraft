//! The server-list status response.
//!
//! When a player adds our address to their multiplayer list, the client opens a
//! connection, sends the handshake with the *status* intent, then a status request.
//! The server answers with one JSON document describing the version, the MOTD and
//! the player counts.
//!
//! We answer this ourselves rather than proxying it. That is what makes the address
//! always look alive — the ping succeeds even while the world is asleep, and it
//! shows who is really online right now, exactly like a normal server.

use serde::{Deserialize, Serialize};

/// The version block shown in the client's server list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusVersion {
    /// The human-readable version, e.g. "1.21.4".
    pub name: String,
    /// The protocol number the client should send. Echoing the client's own number
    /// makes the client show a matching (not "incompatible") version.
    pub protocol: i32,
}

/// The player-count block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusPlayers {
    pub max: u32,
    pub online: u32,
    /// Optional sample list shown when hovering the player count.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample: Vec<StatusSample>,
}

/// One entry in the hover sample.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusSample {
    pub name: String,
    pub id: String,
}

/// A MOTD. Kept as a plain string for the MVP; the client renders legacy color
/// codes, which is enough for a friends' server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StatusDescription {
    /// A single line of text (may contain legacy "§" color codes).
    Text(String),
}

impl From<&str> for StatusDescription {
    fn from(value: &str) -> Self {
        StatusDescription::Text(value.to_string())
    }
}

/// The full status document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusResponse {
    pub version: StatusVersion,
    pub players: StatusPlayers,
    pub description: StatusDescription,
    /// Optional favicon: "data:image/png;base64,...".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    /// Whether the client may chat (1.19+ chat preview). Always false here.
    #[serde(default, rename = "enforcesSecureChat")]
    pub enforces_secure_chat: bool,
}

impl StatusResponse {
    /// Build a status response for a room.
    ///
    /// `protocol` should be the number the client just sent, so the client does not
    /// flag a version mismatch. `online` is the real player count when a host is
    /// live, or 0 while the world sleeps.
    pub fn for_room(
        motd: &str,
        protocol: i32,
        version_name: &str,
        online: u32,
        max: u32,
        players: Vec<String>,
    ) -> Self {
        let sample = players
            .into_iter()
            .map(|name| StatusSample {
                name,
                id: "00000000-0000-0000-0000-000000000000".to_string(),
            })
            .collect();
        Self {
            version: StatusVersion {
                name: version_name.to_string(),
                protocol,
            },
            players: StatusPlayers {
                max,
                online,
                sample,
            },
            description: StatusDescription::from(motd),
            favicon: None,
            enforces_secure_chat: false,
        }
    }
}

/// Serialize a status response to the JSON string the client expects.
pub fn status_json(response: &StatusResponse) -> String {
    serde_json::to_string(response).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_status_document() {
        let s = StatusResponse::for_room(
            "NomadCraft §a在线",
            767,
            "1.21.4",
            3,
            10,
            vec!["Alice".into(), "Bob".into()],
        );
        let json = status_json(&s);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["version"]["protocol"], 767);
        assert_eq!(v["players"]["online"], 3);
        assert_eq!(v["players"]["max"], 10);
        assert_eq!(v["players"]["sample"].as_array().unwrap().len(), 2);
        assert_eq!(v["enforcesSecureChat"], false);
    }

    #[test]
    fn sleeping_world_reports_zero_online() {
        let s = StatusResponse::for_room("zzz", 767, "1.21.4", 0, 10, vec![]);
        let v: serde_json::Value = serde_json::from_str(&status_json(&s)).unwrap();
        assert_eq!(v["players"]["online"], 0);
        assert!(
            v["players"].get("sample").is_none(),
            "empty sample is omitted"
        );
    }

    #[test]
    fn description_is_plain_text() {
        let s = StatusResponse::for_room("hello", 1, "x", 0, 1, vec![]);
        let v: serde_json::Value = serde_json::from_str(&status_json(&s)).unwrap();
        assert_eq!(v["description"], "hello");
    }
}
