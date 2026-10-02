//! Supported agent clients and where they discover content.
//!
//! Discovery paths come from each client's documentation as recorded in
//! `docs/dev/compatibility-research.md` (researched 2026-10-02). Habi writes standard
//! formats only; it does not claim a client loaded anything.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum ClientId {
    ClaudeCode,
    Cursor,
    Codex,
}

impl ClientId {
    pub const ALL: [ClientId; 3] = [ClientId::ClaudeCode, ClientId::Cursor, ClientId::Codex];

    pub fn label(self) -> &'static str {
        match self {
            ClientId::ClaudeCode => "Claude Code",
            ClientId::Cursor => "Cursor",
            ClientId::Codex => "Codex",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            ClientId::ClaudeCode => "claude-code",
            ClientId::Cursor => "cursor",
            ClientId::Codex => "codex",
        }
    }

    pub fn from_slug(s: &str) -> Option<ClientId> {
        ClientId::ALL.into_iter().find(|c| c.slug() == s)
    }
}

pub mod layout;
pub mod mcp;
pub mod sections;
