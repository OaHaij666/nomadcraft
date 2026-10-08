//! Typed, prefixed identifiers.
//!
//! IDs are short, human-readable, and prefixed so that logs and API payloads are
//! self-describing (e.g. `srv_7f3a…`, `node_1b2c…`). They are opaque strings on
//! the wire; the prefix is a debugging aid, not a security boundary.

use serde::{Deserialize, Serialize};

macro_rules! id_type {
    ($name:ident, $prefix:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Prefix shared by every value of this type, e.g. `"srv_"`.
            pub const PREFIX: &'static str = $prefix;

            /// Wrap an already-formatted string. Prefer the generated constructors
            /// unless you are rehydrating a value you produced earlier.
            pub fn from_raw(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            /// Generate a fresh random identifier.
            pub fn generate() -> Self {
                Self(format!("{}{}", $prefix, uuid::Uuid::new_v4().simple()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// True when this value carries the expected prefix.
            pub fn is_valid(&self) -> bool {
                self.0.len() > $prefix.len() && self.0.starts_with($prefix)
            }

            /// Validate a parsed identifier, returning a typed error otherwise.
            pub fn parse(raw: impl Into<String>) -> crate::Result<Self> {
                let raw = raw.into();
                if raw.len() <= $prefix.len() || !raw.starts_with($prefix) {
                    return Err(crate::ProtoError::InvalidId(raw));
                }
                Ok(Self(raw))
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

id_type!(RoomId, "room_", "Identifies a group's shared world.");
id_type!(NodeId, "node_", "Identifies one enrolled machine.");
id_type!(
    ServerId,
    "srv_",
    "Identifies a logical game server inside a room."
);
id_type!(
    SnapshotId,
    "snap_",
    "Identifies an immutable world snapshot."
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_carry_prefix() {
        let id = RoomId::generate();
        assert!(id.is_valid());
        assert!(id.as_str().starts_with("room_"));
    }

    #[test]
    fn parse_rejects_wrong_prefix() {
        assert!(RoomId::parse("node_abc").is_err());
        assert!(RoomId::parse("room_abc").is_ok());
    }

    #[test]
    fn roundtrips_through_json() {
        let id = ServerId::generate();
        let json = serde_json::to_string(&id).unwrap();
        let back: ServerId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }
}
