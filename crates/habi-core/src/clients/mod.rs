//! Supported agent clients and where they discover content.
//!
//! Discovery paths come from each client's documentation as recorded in
//! `docs/dev/compatibility-research.md` (researched 2026-10-02). Habi writes standard
//! formats only; it does not claim a client loaded anything.

use serde::{Deserialize, Serialize};
use std::path::Path;
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

/// What a client leaves in a project, and in the person's home folder, when it is set up.
/// Only files and folders that name one client; `.agents/` and `.mcp.json` are shared.
fn markers(client: ClientId) -> (&'static [&'static str], &'static [&'static str]) {
    match client {
        ClientId::ClaudeCode => (&[".claude", "CLAUDE.md"], &[".claude"]),
        ClientId::Cursor => (&[".cursor", ".cursorrules"], &[".cursor"]),
        ClientId::Codex => (&[".codex"], &[".codex"]),
        ClientId::GeminiCli => (&[".gemini", "GEMINI.md"], &[".gemini"]),
        ClientId::Copilot => (
            &[".github/copilot-instructions.md", ".github/skills"],
            &[".copilot"],
        ),
        ClientId::OpenCode => (
            &[".opencode", "opencode.json", "opencode.jsonc"],
            &[".config/opencode"],
        ),
        ClientId::Junie => (&[".junie"], &[".junie"]),
    }
}

/// The clients a project already shows signs of using, judged by the files at its root.
pub fn in_project(root: &Path) -> Vec<ClientId> {
    ClientId::ALL
        .into_iter()
        .filter(|&c| markers(c).0.iter().any(|m| root.join(m).exists()))
        .collect()
}

/// The clients the person has set up, judged by the folder each keeps in their home folder.
pub fn on_machine(home: &Path) -> Vec<ClientId> {
    ClientId::ALL
        .into_iter()
        .filter(|&c| markers(c).1.iter().any(|m| home.join(m).exists()))
        .collect()
}

pub mod layout;
pub mod mcp;
pub mod sections;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_shows_the_clients_it_uses() {
        let dir = tempfile::tempdir().unwrap();
        assert!(in_project(dir.path()).is_empty());
        std::fs::create_dir_all(dir.path().join(".claude/skills")).unwrap();
        std::fs::write(dir.path().join("GEMINI.md"), "").unwrap();
        std::fs::create_dir_all(dir.path().join(".github")).unwrap();
        std::fs::write(dir.path().join(".github/copilot-instructions.md"), "").unwrap();
        // Shared files name no client.
        std::fs::create_dir_all(dir.path().join(".agents/skills")).unwrap();
        std::fs::write(dir.path().join(".mcp.json"), "{}").unwrap();
        assert_eq!(
            in_project(dir.path()),
            [ClientId::ClaudeCode, ClientId::GeminiCli, ClientId::Copilot]
        );
    }

    #[test]
    fn a_machine_shows_the_clients_set_up_in_the_home_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".config/opencode")).unwrap();
        std::fs::create_dir_all(dir.path().join(".junie")).unwrap();
        assert_eq!(
            on_machine(dir.path()),
            [ClientId::OpenCode, ClientId::Junie]
        );
    }
}
