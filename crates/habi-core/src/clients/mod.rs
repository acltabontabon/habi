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
    GeminiCli,
    Copilot,
    #[serde(rename = "opencode")]
    #[ts(rename = "opencode")]
    OpenCode,
    Junie,
}

impl ClientId {
    pub const ALL: [ClientId; 7] = [
        ClientId::ClaudeCode,
        ClientId::Cursor,
        ClientId::Codex,
        ClientId::GeminiCli,
        ClientId::Copilot,
        ClientId::OpenCode,
        ClientId::Junie,
    ];

    pub fn label(self) -> &'static str {
        match self {
            ClientId::ClaudeCode => "Claude Code",
            ClientId::Cursor => "Cursor",
            ClientId::Codex => "Codex",
            ClientId::GeminiCli => "Gemini CLI",
            ClientId::Copilot => "GitHub Copilot",
            ClientId::OpenCode => "OpenCode",
            ClientId::Junie => "Junie",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            ClientId::ClaudeCode => "claude-code",
            ClientId::Cursor => "cursor",
            ClientId::Codex => "codex",
            ClientId::GeminiCli => "gemini-cli",
            ClientId::Copilot => "copilot",
            ClientId::OpenCode => "opencode",
            ClientId::Junie => "junie",
        }
    }

    pub fn from_slug(s: &str) -> Option<ClientId> {
        ClientId::ALL.into_iter().find(|c| c.slug() == s)
    }
}

pub mod layout;
pub mod mcp;
pub mod sections;
