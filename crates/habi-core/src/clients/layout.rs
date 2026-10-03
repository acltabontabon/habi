//! Where each client discovers project-level skills, and how Habi chooses the
//! smallest set of directories that serves the selected clients.
//!
//! From `docs/dev/compatibility-research.md` (2026-10-02):
//! - Codex reads `.agents/skills`.
//! - Cursor reads `.agents/skills`, `.cursor/skills`, and also `.claude/skills`.
//! - Claude Code reads `.claude/skills` (not `.agents/skills`).

use super::ClientId;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const AGENTS_SKILLS: &str = ".agents/skills";
pub const CLAUDE_SKILLS: &str = ".claude/skills";
pub const CURSOR_SKILLS: &str = ".cursor/skills";

/// Every project folder a client reads skills from.
pub const PROJECT_SKILL_DIRS: [&str; 3] = [CLAUDE_SKILLS, AGENTS_SKILLS, CURSOR_SKILLS];

/// A skills directory in the person's home folder, and the clients that read
/// it. Habi only reads these; it never writes to one.
#[derive(Debug, Clone, Copy)]
pub struct UserSkillDir {
    /// Names the directory in a skill's id ("claude", "agents", "cursor").
    pub key: &'static str,
    /// Relative to the home folder.
    pub base: &'static str,
    pub readers: &'static [ClientId],
}

/// From `docs/dev/compatibility-research.md`: Cursor also reads
/// `~/.claude/skills` as a compatibility path. `~/.codex/skills` is left out
/// because Codex's own documentation does not list it.
pub const USER_SKILL_DIRS: [UserSkillDir; 3] = [
    UserSkillDir {
        key: "claude",
        base: ".claude/skills",
        readers: &[ClientId::ClaudeCode, ClientId::Cursor],
    },
    UserSkillDir {
        key: "agents",
        base: ".agents/skills",
        readers: &[ClientId::Codex, ClientId::Cursor],
    },
    UserSkillDir {
        key: "cursor",
        base: ".cursor/skills",
        readers: &[ClientId::Cursor],
    },
];

/// Which copy a client uses when the same skill name exists for the person
/// and in a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Precedence {
    /// The personal copy wins.
    PersonalWins,
    /// The client's documentation does not say.
    NotDocumented,
}

/// Claude Code ranks skills enterprise > personal > project. Cursor and Codex
/// do not document an order (research doc §4).
pub fn precedence(client: ClientId) -> Precedence {
    match client {
        ClientId::ClaudeCode => Precedence::PersonalWins,
        ClientId::Cursor | ClientId::Codex => Precedence::NotDocumented,
    }
}

/// A directory Habi writes a skill into, and the clients it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDir {
    pub base: &'static str,
    pub clients: Vec<ClientId>,
}

/// Chooses skill directories for the selected clients, avoiding duplicate
/// copies where one directory serves several clients.
pub fn skill_dirs(clients: &[ClientId]) -> (Vec<SkillDir>, Vec<String>) {
    let claude = clients.contains(&ClientId::ClaudeCode);
    let cursor = clients.contains(&ClientId::Cursor);
    let codex = clients.contains(&ClientId::Codex);
    let mut dirs = Vec::new();
    let mut notes = Vec::new();

    // `.agents/skills` serves Codex and Cursor. Use it when Codex is selected,
    // or when Cursor is selected without Claude Code.
    let use_agents = codex || (cursor && !claude);
    if use_agents {
        let mut served = Vec::new();
        if codex {
            served.push(ClientId::Codex);
        }
        if cursor {
            served.push(ClientId::Cursor);
        }
        dirs.push(SkillDir {
            base: AGENTS_SKILLS,
            clients: served,
        });
    }
    if claude {
        let mut served = vec![ClientId::ClaudeCode];
        if cursor && !use_agents {
            // Cursor also reads `.claude/skills`, so one copy serves both.
            served.push(ClientId::Cursor);
        }
        dirs.push(SkillDir {
            base: CLAUDE_SKILLS,
            clients: served,
        });
    }
    if claude && cursor && use_agents {
        notes.push(
            "Cursor reads both .agents/skills and .claude/skills, so it will find two copies of this skill. Cursor's handling of duplicate names is not documented; if it matters, install for Cursor through one of them only."
                .to_string(),
        );
    }
    (dirs, notes)
}

/// Which clients may discover content in a given project-relative path.
pub fn readers_of(path: &str) -> Vec<ClientId> {
    if path.starts_with(".agents/skills/") {
        vec![ClientId::Codex, ClientId::Cursor]
    } else if path.starts_with(".claude/skills/") {
        vec![ClientId::ClaudeCode, ClientId::Cursor]
    } else if path.starts_with(".cursor/skills/") {
        vec![ClientId::Cursor]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_directories() {
        let (d, n) = skill_dirs(&[ClientId::Codex]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].base, AGENTS_SKILLS);
        assert!(n.is_empty());

        let (d, _) = skill_dirs(&[ClientId::ClaudeCode, ClientId::Cursor]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].base, CLAUDE_SKILLS);
        assert_eq!(d[0].clients, vec![ClientId::ClaudeCode, ClientId::Cursor]);

        let (d, _) = skill_dirs(&[ClientId::Cursor]);
        assert_eq!(d[0].base, AGENTS_SKILLS);

        let (d, n) = skill_dirs(&ClientId::ALL);
        assert_eq!(d.len(), 2);
        assert_eq!(n.len(), 1);
    }
}
