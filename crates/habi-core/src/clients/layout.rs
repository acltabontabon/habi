//! Where each client discovers project-level skills, and how Habi chooses the
//! smallest set of directories that serves the selected clients.
//!
//! From each client's documentation (researched 2026-10-02, 2026-10-03):
//! - `.agents/skills` is read by Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode and Junie.
//! - `.claude/skills` is read by Claude Code, and also by Cursor, Copilot and OpenCode.
//! - Each of Cursor, Gemini CLI, Copilot, OpenCode and Junie also has a folder of its own.
//!
//! Habi writes skills only into `.agents/skills` and `.claude/skills`. The skill folders a single
//! client owns are read (to see what a project already has) but never written.
//!
//! Subagents are single Markdown files, and no folder is shared by every client that has them
//! (researched 2026-11-24):
//! - `.claude/agents` is read by Claude Code, and also by Cursor.
//! - `.cursor/agents` is Cursor's own, and `.junie/agents` is Junie's.
//! - Junie also reads every Markdown file in `.agents`, so nothing is written there.
//!
//! Codex and OpenCode define agents in formats of their own, and the others have none.

use super::ClientId;
use crate::library::model::ItemKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const AGENTS_SKILLS: &str = ".agents/skills";
pub const CLAUDE_SKILLS: &str = ".claude/skills";
pub const CURSOR_SKILLS: &str = ".cursor/skills";
pub const GEMINI_SKILLS: &str = ".gemini/skills";
pub const COPILOT_SKILLS: &str = ".github/skills";
pub const OPENCODE_SKILLS: &str = ".opencode/skills";
pub const JUNIE_SKILLS: &str = ".junie/skills";

pub const CLAUDE_AGENTS: &str = ".claude/agents";
pub const CURSOR_AGENTS: &str = ".cursor/agents";
pub const JUNIE_AGENTS: &str = ".junie/agents";

/// The folders Habi writes subagents into, in a project and under the home folder.
pub const AGENT_DIRS: [&str; 3] = [CLAUDE_AGENTS, CURSOR_AGENTS, JUNIE_AGENTS];

/// The clients that take a subagent as the Markdown file it is.
pub const AGENT_CLIENTS: [ClientId; 3] = [ClientId::ClaudeCode, ClientId::Cursor, ClientId::Junie];

/// Chooses the folders a subagent is written into. Cursor reads Claude Code's
/// folder, so one copy serves both when both are selected.
pub fn agent_dirs(clients: &[ClientId]) -> Vec<SkillDir> {
    let has = |c: ClientId| clients.contains(&c);
    let mut dirs = Vec::new();
    if has(ClientId::ClaudeCode) {
        let mut served = vec![ClientId::ClaudeCode];
        served.extend(has(ClientId::Cursor).then_some(ClientId::Cursor));
        dirs.push(SkillDir {
            base: CLAUDE_AGENTS,
            clients: served,
        });
    } else if has(ClientId::Cursor) {
        dirs.push(SkillDir {
            base: CURSOR_AGENTS,
            clients: vec![ClientId::Cursor],
        });
    }
    if has(ClientId::Junie) {
        dirs.push(SkillDir {
            base: JUNIE_AGENTS,
            clients: vec![ClientId::Junie],
        });
    }
    dirs
}

/// Where a file Habi installed sits: the folder Habi writes that kind of item
/// into, the item's name there, and the file within the item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Managed<'a> {
    pub base: &'static str,
    pub name: &'a str,
    /// The file as the library names it within the item.
    pub rel: &'a str,
}

impl Managed<'_> {
    /// The folder that holds the whole item, for a kind that has one.
    pub fn folder(&self) -> String {
        format!("{}/{}", self.base, self.name)
    }
}

/// Reads a root-relative path as a place Habi installs an item of `kind`:
/// `<skills folder>/<name>/<file>` for a skill, `<agents folder>/<name>.md`
/// for a subagent. `None` for anywhere else, which Habi neither writes nor
/// deletes. Every reader of a lock file's paths goes through this.
pub fn managed_location(kind: ItemKind, path: &str) -> Option<Managed<'_>> {
    if kind == ItemKind::Agent {
        return AGENT_DIRS.iter().find_map(|base| {
            let file = path.strip_prefix(base)?.strip_prefix('/')?;
            let name = file.strip_suffix(".md")?;
            (!name.is_empty() && !file.contains('/')).then_some(Managed {
                base,
                name,
                rel: file,
            })
        });
    }
    [AGENTS_SKILLS, CLAUDE_SKILLS].iter().find_map(|base| {
        let rest = path.strip_prefix(base)?.strip_prefix('/')?;
        let (name, rel) = rest.split_once('/')?;
        Some(Managed { base, name, rel })
    })
}

/// Every project folder a client reads skills from.
pub const PROJECT_SKILL_DIRS: [&str; 7] = [
    CLAUDE_SKILLS,
    AGENTS_SKILLS,
    CURSOR_SKILLS,
    GEMINI_SKILLS,
    COPILOT_SKILLS,
    OPENCODE_SKILLS,
    JUNIE_SKILLS,
];

/// The project folders a client reads skills from.
pub fn project_dirs(client: ClientId) -> &'static [&'static str] {
    match client {
        ClientId::ClaudeCode => &[CLAUDE_SKILLS],
        ClientId::Cursor => &[AGENTS_SKILLS, CURSOR_SKILLS, CLAUDE_SKILLS],
        ClientId::Codex => &[AGENTS_SKILLS],
        ClientId::GeminiCli => &[AGENTS_SKILLS, GEMINI_SKILLS],
        ClientId::Copilot => &[AGENTS_SKILLS, CLAUDE_SKILLS, COPILOT_SKILLS],
        ClientId::OpenCode => &[AGENTS_SKILLS, CLAUDE_SKILLS, OPENCODE_SKILLS],
        ClientId::Junie => &[AGENTS_SKILLS, JUNIE_SKILLS],
    }
}

/// A skills directory in the person's home folder, and the clients that read
/// it. Habi reads all of them. Installing on this machine writes only the two
/// shared ones, `~/.claude/skills` and `~/.agents/skills` (as in a project),
/// never a folder that a single client owns.
#[derive(Debug, Clone, Copy)]
pub struct UserSkillDir {
    /// Names the directory in a skill's id ("claude", "agents", "cursor").
    pub key: &'static str,
    /// Relative to the home folder.
    pub base: &'static str,
    pub readers: &'static [ClientId],
}

/// The home folders each client documents. `~/.codex/skills` is left out
/// because Codex's own documentation does not list it.
pub const USER_SKILL_DIRS: [UserSkillDir; 7] = [
    UserSkillDir {
        key: "claude",
        base: ".claude/skills",
        readers: &[
            ClientId::ClaudeCode,
            ClientId::Cursor,
            ClientId::Copilot,
            ClientId::OpenCode,
        ],
    },
    UserSkillDir {
        key: "agents",
        base: ".agents/skills",
        readers: &[
            ClientId::Codex,
            ClientId::Cursor,
            ClientId::GeminiCli,
            ClientId::Copilot,
            ClientId::OpenCode,
            ClientId::Junie,
        ],
    },
    UserSkillDir {
        key: "cursor",
        base: ".cursor/skills",
        readers: &[ClientId::Cursor],
    },
    UserSkillDir {
        key: "gemini",
        base: ".gemini/skills",
        readers: &[ClientId::GeminiCli],
    },
    UserSkillDir {
        key: "copilot",
        base: ".copilot/skills",
        readers: &[ClientId::Copilot],
    },
    UserSkillDir {
        key: "opencode",
        base: ".config/opencode/skills",
        readers: &[ClientId::OpenCode],
    },
    UserSkillDir {
        key: "junie",
        base: ".junie/skills",
        readers: &[ClientId::Junie],
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
    /// The project's copy wins.
    ProjectWins,
    /// The client's documentation does not say.
    NotDocumented,
}

/// Claude Code ranks skills enterprise > personal > project. Gemini CLI ranks
/// user < workspace. The others do not document an order (research doc §4, §8).
pub fn precedence(client: ClientId) -> Precedence {
    match client {
        ClientId::ClaudeCode => Precedence::PersonalWins,
        ClientId::GeminiCli => Precedence::ProjectWins,
        ClientId::Cursor
        | ClientId::Codex
        | ClientId::Copilot
        | ClientId::OpenCode
        | ClientId::Junie => Precedence::NotDocumented,
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
///
/// A client that reads only one of Habi's two folders decides that folder is
/// needed. A client that reads both (Cursor, Copilot, OpenCode) is served by
/// whichever is already needed, and by `.agents/skills` when nothing else
/// asks for a folder.
pub fn skill_dirs(clients: &[ClientId]) -> (Vec<SkillDir>, Vec<String>) {
    let reads = |c: ClientId, base: &str| project_dirs(c).contains(&base);
    let flexible = |c: ClientId| reads(c, AGENTS_SKILLS) && reads(c, CLAUDE_SKILLS);
    let only = |base: &str| clients.iter().any(|&c| !flexible(c) && reads(c, base));
    let use_claude = only(CLAUDE_SKILLS);
    let use_agents = only(AGENTS_SKILLS) || (!use_claude && clients.iter().any(|&c| flexible(c)));

    let mut dirs = Vec::new();
    if use_agents {
        let served = clients
            .iter()
            .copied()
            .filter(|&c| reads(c, AGENTS_SKILLS))
            .collect();
        dirs.push(SkillDir {
            base: AGENTS_SKILLS,
            clients: served,
        });
    }
    if use_claude {
        // A client that reads both is already served by `.agents/skills`
        // when that is written.
        let served = clients
            .iter()
            .copied()
            .filter(|&c| reads(c, CLAUDE_SKILLS) && !(use_agents && flexible(c)))
            .collect();
        dirs.push(SkillDir {
            base: CLAUDE_SKILLS,
            clients: served,
        });
    }

    let mut notes = Vec::new();
    if use_agents && use_claude {
        let twice: Vec<&str> = clients
            .iter()
            .filter(|&&c| flexible(c))
            .map(|c| c.label())
            .collect();
        if !twice.is_empty() {
            let (names, verb, pronoun) = match twice.as_slice() {
                [one] => ((*one).to_string(), "reads", "it"),
                [rest @ .., last] => (format!("{} and {last}", rest.join(", ")), "read", "them"),
                [] => (String::new(), "read", "them"),
            };
            notes.push(format!(
                "{names} {verb} both .agents/skills and .claude/skills, so will find two copies of this skill. How a client handles duplicate names is not documented; if it matters, install for {pronoun} through one of them only."
            ));
        }
    }
    (dirs, notes)
}

/// Which clients may discover content in a given project-relative path.
pub fn readers_of(path: &str) -> Vec<ClientId> {
    PROJECT_SKILL_DIRS
        .iter()
        .find(|base| path.starts_with(&format!("{base}/")))
        .map(|base| {
            ClientId::ALL
                .into_iter()
                .filter(|&c| project_dirs(c).contains(base))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ClientId::*;

    fn bases(clients: &[ClientId]) -> Vec<&'static str> {
        skill_dirs(clients).0.iter().map(|d| d.base).collect()
    }

    #[test]
    fn minimal_directories() {
        let (d, n) = skill_dirs(&[Codex]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].base, AGENTS_SKILLS);
        assert!(n.is_empty());

        let (d, _) = skill_dirs(&[ClaudeCode, Cursor]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].base, CLAUDE_SKILLS);
        assert_eq!(d[0].clients, vec![ClaudeCode, Cursor]);

        let (d, _) = skill_dirs(&[Cursor]);
        assert_eq!(d[0].base, AGENTS_SKILLS);

        let (d, n) = skill_dirs(&[ClaudeCode, Cursor, Codex]);
        assert_eq!(d.len(), 2);
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn each_new_client_alone_uses_agents_skills() {
        for c in [GeminiCli, Copilot, OpenCode, Junie] {
            assert_eq!(bases(&[c]), vec![AGENTS_SKILLS], "{c:?}");
        }
    }

    #[test]
    fn claude_code_with_a_flexible_client_needs_one_folder() {
        for c in [Cursor, Copilot, OpenCode] {
            assert_eq!(bases(&[ClaudeCode, c]), vec![CLAUDE_SKILLS], "{c:?}");
        }
    }

    #[test]
    fn claude_code_with_an_agents_only_client_needs_both() {
        for c in [Codex, GeminiCli, Junie] {
            assert_eq!(
                bases(&[ClaudeCode, c]),
                vec![AGENTS_SKILLS, CLAUDE_SKILLS],
                "{c:?}"
            );
            let (_, notes) = skill_dirs(&[ClaudeCode, c]);
            assert!(notes.is_empty(), "{c:?} reads only one of the two");
        }
    }

    #[test]
    fn all_seven_clients_write_two_folders_and_name_who_finds_two_copies() {
        let (d, n) = skill_dirs(&ClientId::ALL);
        assert_eq!(d.len(), 2);
        assert_eq!(n.len(), 1);
        let note = &n[0];
        for c in [Cursor, Copilot, OpenCode] {
            assert!(note.contains(c.label()), "{note}");
        }
        for c in [Codex, GeminiCli, Junie, ClaudeCode] {
            assert!(!note.contains(c.label()), "{note}");
        }
        let agents = d.iter().find(|x| x.base == AGENTS_SKILLS).unwrap();
        let claude = d.iter().find(|x| x.base == CLAUDE_SKILLS).unwrap();
        assert_eq!(claude.clients, vec![ClaudeCode]);
        assert_eq!(agents.clients.len(), 6);
    }

    #[test]
    fn every_selected_client_can_find_a_skill_in_a_folder_that_is_written() {
        for mask in 1u32..(1 << ClientId::ALL.len()) {
            let picked: Vec<ClientId> = ClientId::ALL
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, c)| *c)
                .collect();
            let (dirs, _) = skill_dirs(&picked);
            for c in &picked {
                assert!(
                    dirs.iter().any(|d| project_dirs(*c).contains(&d.base)),
                    "{c:?} in {picked:?} reads none of {:?}",
                    dirs.iter().map(|d| d.base).collect::<Vec<_>>()
                );
            }
            for d in &dirs {
                assert!(
                    !d.clients.is_empty(),
                    "{picked:?} writes an unused {}",
                    d.base
                );
            }
        }
    }

    #[test]
    fn one_agents_folder_serves_claude_code_and_cursor() {
        let bases = |clients: &[ClientId]| -> Vec<&str> {
            agent_dirs(clients).iter().map(|d| d.base).collect()
        };
        assert_eq!(bases(&[ClaudeCode, Cursor]), [CLAUDE_AGENTS]);
        assert_eq!(
            agent_dirs(&[ClaudeCode, Cursor])[0].clients,
            [ClaudeCode, Cursor]
        );
        assert_eq!(bases(&[Cursor]), [CURSOR_AGENTS]);
        assert_eq!(bases(&[Cursor, Junie]), [CURSOR_AGENTS, JUNIE_AGENTS]);
        assert_eq!(bases(&[ClaudeCode, Junie]), [CLAUDE_AGENTS, JUNIE_AGENTS]);
        assert!(bases(&[Codex, GeminiCli, Copilot, OpenCode]).is_empty());
    }

    #[test]
    fn a_managed_location_is_a_skill_file_or_one_agent_file() {
        let skill =
            managed_location(ItemKind::Skill, ".claude/skills/review/scripts/a.sh").unwrap();
        assert_eq!(
            (skill.base, skill.name, skill.rel),
            (CLAUDE_SKILLS, "review", "scripts/a.sh")
        );
        assert_eq!(skill.folder(), ".claude/skills/review");
        let agent = managed_location(ItemKind::Agent, ".junie/agents/reviewer.md").unwrap();
        assert_eq!(
            (agent.base, agent.name, agent.rel),
            (JUNIE_AGENTS, "reviewer", "reviewer.md")
        );
        for (kind, refused) in [
            (ItemKind::Skill, ".claude/skills/SKILL.md"),
            (ItemKind::Skill, ".claude/skillsx/a/SKILL.md"),
            (ItemKind::Skill, ".claude/agents/reviewer.md"),
            (ItemKind::Skill, ".cursor/skills/a/SKILL.md"),
            (ItemKind::Agent, ".claude/agents/team/reviewer.md"),
            (ItemKind::Agent, ".claude/agents/reviewer.sh"),
            (ItemKind::Agent, ".claude/agents/.md"),
            (ItemKind::Agent, ".claude/skills/a/SKILL.md"),
            (ItemKind::Agent, ".agents/reviewer.md"),
            (ItemKind::Agent, ".claude/settings.json"),
        ] {
            assert_eq!(managed_location(kind, refused), None, "{refused}");
        }
    }

    #[test]
    fn readers_follow_the_table() {
        assert_eq!(readers_of(".junie/skills/x/SKILL.md"), vec![Junie]);
        assert_eq!(
            readers_of(".claude/skills/x/SKILL.md"),
            vec![ClaudeCode, Cursor, Copilot, OpenCode]
        );
        assert_eq!(readers_of(".agents/skills/x/SKILL.md").len(), 6);
        assert!(readers_of("docs/x.md").is_empty());
    }

    #[test]
    fn shared_home_folders_agree_with_project_folders() {
        for u in USER_SKILL_DIRS
            .iter()
            .filter(|u| u.key == "claude" || u.key == "agents")
        {
            let expected: Vec<ClientId> = ClientId::ALL
                .into_iter()
                .filter(|c| project_dirs(*c).contains(&u.base))
                .collect();
            let mut got = u.readers.to_vec();
            got.sort();
            assert_eq!(got, expected, "~/{}", u.base);
        }
    }
}
