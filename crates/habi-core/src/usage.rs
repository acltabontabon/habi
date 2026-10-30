//! Whether a project's skills get used, and what they cost in context.
//!
//! Claude Code keeps each session as JSON lines in
//! `~/.claude/projects/<encoded folder>/<session>.jsonl`, and a subagent's in
//! `<session>/subagents/*.jsonl`. When asked, and only then, this reads the
//! last 30 days of them for three kinds of record, and keeps a skill name and
//! a time from each:
//! - the agent calling the `Skill` tool, unless the call failed;
//! - a person typing a skill as a slash command (`<command-name>`);
//! - the skills a session offered its agent (a `skill_listing` attachment).
//!
//! Nothing is stored and nothing else is looked at. "Not used" is said only of
//! a skill a session offered: a folder Claude Code does not read, a skill newer
//! than any session, or a format this no longer understands all end in saying
//! nothing, never in calling a skill dead. The format is Claude Code's own and
//! undocumented; `docs/dev/compatibility-research.md` records what was checked,
//! and what other agents keep.

use crate::cancel::CancelToken;
use crate::clients::ClientId;
use crate::error::Result;
use crate::skills::intake::DiscoveredSkill;
use crate::suggest::tokens_of;
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs::{self, DirEntry, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;
use time::{Duration, OffsetDateTime};
use ts_rs::TS;

/// How far back sessions are read.
pub const WINDOW_DAYS: u32 = 30;

/// Where Claude Code keeps session transcripts, under the home folder.
pub const TRANSCRIPTS_DIR: &str = ".claude/projects";

/// A skill's use, as far as a project's transcripts show it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageSeen {
    /// Skill calls and slash commands.
    pub uses: u32,
    /// When it was last used; `None` when it was not.
    pub last_used: Option<String>,
    /// The days this covers: since a session first offered or used the skill,
    /// up to the 30 days read.
    pub days: u32,
}

/// One skill in a project.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillUsage {
    /// The name in SKILL.md, or the folder's when it has none.
    pub name: String,
    /// What its name and description cost in every agent session, in tokens;
    /// 0 when it has no description, so nothing is listed.
    pub tokens: u32,
    /// `None` when the transcripts give nothing to go on, which is not the
    /// same as unused.
    pub usage: Option<UsageSeen>,
}

/// What Claude Code's transcripts say about a project's skills.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillUsageReport {
    /// Some transcripts were skipped (a limit, an unreadable file): uses may be
    /// missing, so counts are minimums and no skill is called unused.
    pub partial: bool,
    pub skills: Vec<SkillUsage>,
}

/// Bounds on one read of a project's transcripts.
#[derive(Debug, Clone, Copy)]
pub struct UsageLimits {
    pub files: usize,
    pub file_bytes: u64,
    pub total_bytes: u64,
    pub line_bytes: usize,
}

impl UsageLimits {
    /// Well above a heavy user's: 1.5 GB in a project, 170 MB in a session and
    /// 2.4 MB on a line were the largest found while writing this.
    pub const DEFAULT: UsageLimits = UsageLimits {
        files: 5_000,
        file_bytes: 512 * 1024 * 1024,
        total_bytes: 4 * 1024 * 1024 * 1024,
        line_bytes: 16 * 1024 * 1024,
    };
}

/// The transcript folder Claude Code names after a session's starting folder:
/// everything but ASCII letters and digits becomes `-`.
pub fn transcript_folder(project: &Path) -> String {
    project
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The skill's name in the opening `<command-name>` of a user record: a typed
/// slash command, or a skill loaded for the session. Text that only mentions
/// the tag is left alone.
fn command_name(text: &str) -> Option<&str> {
    let head = text.trim_start();
    if !head.starts_with("<command-name>") && !head.starts_with("<command-message>") {
        return None;
    }
    let (_, rest) = head.split_once("<command-name>")?;
    let (name, _) = rest.split_once("</command-name>")?;
    Some(name.trim().trim_start_matches('/'))
}

/// Lines that can matter, so the rest (nearly all the bytes) are never parsed.
fn candidate(line: &[u8]) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r#""skill_listing"|<command-name>|"Skill"|"is_error":\s*true"#).unwrap()
        })
        .is_match(line)
}

struct Tally<'a> {
    root: &'a Path,
    cutoff: OffsetDateTime,
    /// Name or folder name to skill. Only skills Claude Code can read.
    watched: HashMap<&'a str, usize>,
    /// By tool call or record id: a resumed session can repeat its records.
    uses: HashMap<String, (usize, OffsetDateTime)>,
    first_seen: Vec<Option<OffsetDateTime>>,
}

impl Tally<'_> {
    fn seen(&mut self, skill: usize, at: OffsetDateTime) {
        if let Some(first) = self.first_seen.get_mut(skill) {
            *first = Some(first.map_or(at, |f| f.min(at)));
        }
    }

    fn used(&mut self, id: &str, name: &str, at: OffsetDateTime) {
        if at < self.cutoff {
            return;
        }
        if let Some(&skill) = self.watched.get(name) {
            self.uses.insert(id.to_string(), (skill, at));
            self.seen(skill, at);
        }
    }

    fn offered(&mut self, record: &Value, at: OffsetDateTime) {
        if record.pointer("/attachment/type").and_then(Value::as_str) != Some("skill_listing") {
            return;
        }
        let names = record
            .pointer("/attachment/names")
            .and_then(Value::as_array);
        for name in names.into_iter().flatten().filter_map(Value::as_str) {
            if let Some(&skill) = self.watched.get(name) {
                // A session that began before the window still offered it inside the window.
                self.seen(skill, at.max(self.cutoff));
            }
        }
    }

    fn agent_calls(&mut self, record: &Value, at: OffsetDateTime) {
        let blocks = record.pointer("/message/content").and_then(Value::as_array);
        for block in blocks.into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("Skill")
                && let (Some(id), Some(name)) = (
                    block.get("id").and_then(Value::as_str),
                    block.pointer("/input/skill").and_then(Value::as_str),
                )
            {
                self.used(id, name, at);
            }
        }
    }

    fn user_turn(&mut self, record: &Value, at: OffsetDateTime) {
        let id = record.get("uuid").and_then(Value::as_str).unwrap_or("");
        match record.pointer("/message/content") {
            Some(Value::String(text)) => {
                if let Some(name) = command_name(text) {
                    self.used(id, name, at);
                }
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        // Refused, or no such skill: the call is not a use.
                        Some("tool_result")
                            if block.get("is_error").and_then(Value::as_bool) == Some(true) =>
                        {
                            if let Some(call) = block.get("tool_use_id").and_then(Value::as_str) {
                                self.uses.remove(call);
                            }
                        }
                        Some("text") => {
                            let name = block
                                .get("text")
                                .and_then(Value::as_str)
                                .and_then(command_name);
                            if let Some(name) = name {
                                self.used(id, name, at);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn record(&mut self, line: &[u8]) {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        // Folder names are lossy (`/a/b-c` and `/a/b/c` share one, and `/a/b-c`
        // starts like `/a/b`), so the record's own folder decides.
        let Some(cwd) = record.get("cwd").and_then(Value::as_str) else {
            return;
        };
        if !Path::new(cwd).starts_with(self.root) {
            return;
        }
        let Some(at) = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::time::parse)
        else {
            return;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("attachment") => self.offered(&record, at),
            Some("assistant") => self.agent_calls(&record, at),
            Some("user") => self.user_turn(&record, at),
            _ => {}
        }
    }
}

struct Transcript {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

/// A directory's entries. A missing directory is no history, not a problem.
fn entries(dir: &Path, partial: &mut bool) -> Vec<DirEntry> {
    match fs::read_dir(dir) {
        Ok(read) => read.flatten().collect(),
        Err(e) => {
            *partial |= e.kind() != std::io::ErrorKind::NotFound;
            Vec::new()
        }
    }
}

fn is_dir(entry: &DirEntry) -> bool {
    // `file_type` describes a link as a link, so links are never entered.
    entry.file_type().is_ok_and(|t| t.is_dir())
}

/// The `.jsonl` files directly in `dir`, modified since `since`. Links are skipped.
fn collect(dir: &Path, since: SystemTime, partial: &mut bool, out: &mut Vec<Transcript>) {
    for entry in entries(dir, partial) {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            *partial = true;
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or_else(|_| SystemTime::now());
        if modified >= since {
            out.push(Transcript {
                path,
                modified,
                size: meta.len(),
            });
        }
    }
}

/// Transcripts of sessions started in the project or below it (a subfolder, a
/// worktree under `.claude/worktrees`), the newest first. Folders of others
/// that merely start alike are listed too; `Tally::record` turns them away.
fn transcripts(
    dir: &Path,
    project: &Path,
    since: SystemTime,
    partial: &mut bool,
) -> Vec<Transcript> {
    let folder = transcript_folder(project);
    let below = format!("{folder}-");
    let mut out = Vec::new();
    for entry in entries(dir, partial) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_dir(&entry) || (name != folder && !name.starts_with(&below)) {
            continue;
        }
        collect(&entry.path(), since, partial, &mut out);
        for session in entries(&entry.path(), partial) {
            if !is_dir(&session) {
                continue;
            }
            for sub in entries(&session.path(), partial) {
                if sub.file_name() == "subagents" && is_dir(&sub) {
                    collect(&sub.path(), since, partial, &mut out);
                }
            }
        }
    }
    out.sort_by_key(|t| Reverse(t.modified));
    out
}

/// Reads the next line into `line`, whatever its length, keeping at most `limit`
/// bytes in memory. `Ok(None)` at the end; `Ok(Some(false))` when it was too long.
fn next_line(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<bool>> {
    line.clear();
    let mut fits = true;
    let mut any = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(any.then_some(fits));
        }
        any = true;
        let newline = buffer.iter().position(|b| *b == b'\n');
        let (part, done) = match newline.and_then(|i| buffer.get(..=i)) {
            Some(part) => (part, true),
            None => (buffer, false),
        };
        let taken = part.len();
        if fits && line.len() + taken <= limit {
            line.extend_from_slice(part);
        } else {
            fits = false;
            line.clear();
        }
        reader.consume(taken);
        if done {
            return Ok(Some(fits));
        }
    }
}

fn read_transcript(
    file: File,
    tally: &mut Tally<'_>,
    limits: &UsageLimits,
    cancel: &CancelToken,
    partial: &mut bool,
) -> Result<()> {
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    let mut read: u32 = 0;
    loop {
        match next_line(&mut reader, &mut line, limits.line_bytes) {
            Ok(None) => return Ok(()),
            Ok(Some(true)) => {
                if candidate(&line) {
                    tally.record(&line);
                }
            }
            Ok(Some(false)) => *partial = true,
            Err(_) => {
                *partial = true;
                return Ok(());
            }
        }
        read = read.wrapping_add(1);
        if read.is_multiple_of(4096) {
            cancel.check()?;
        }
    }
}

/// What the transcripts under `dir` say about `skills`, the skills found in the
/// project at `root`. Read-only; only names and times are kept while it runs.
pub fn read_usage(
    dir: &Path,
    root: &Path,
    skills: &[DiscoveredSkill],
    now: OffsetDateTime,
    limits: &UsageLimits,
    cancel: &CancelToken,
) -> Result<SkillUsageReport> {
    // A skill can be in several agents' folders; it is one skill, and one line in a listing.
    let mut unique: Vec<(&DiscoveredSkill, u32)> = Vec::new();
    for skill in skills {
        let tokens = if skill.description.trim().is_empty() {
            0
        } else {
            tokens_of(&skill.name, &skill.description)
        };
        match unique.iter_mut().find(|(s, _)| s.name == skill.name) {
            Some((kept, most)) => {
                *most = (*most).max(tokens);
                if !kept.readers.contains(&ClientId::ClaudeCode) {
                    *kept = skill;
                }
            }
            None => unique.push((skill, tokens)),
        }
    }

    let cutoff = now - Duration::days(i64::from(WINDOW_DAYS));
    let mut watched: HashMap<&str, usize> = HashMap::new();
    for (i, (skill, _)) in unique.iter().enumerate() {
        if skill.readers.contains(&ClientId::ClaudeCode) {
            watched.insert(&skill.name, i);
            // Agents may go by the folder where `name` differs from it.
            if let Some(folder) = skill.path.rsplit('/').next() {
                watched.insert(folder, i);
            }
        }
    }
    let mut tally = Tally {
        root,
        cutoff,
        watched,
        uses: HashMap::new(),
        first_seen: vec![None; unique.len()],
    };

    let mut partial = false;
    let since = SystemTime::from(cutoff);
    let mut total: u64 = 0;
    let mut files: usize = 0;
    // With nothing to look for, no transcript is opened at all.
    let found = if tally.watched.is_empty() {
        Vec::new()
    } else {
        transcripts(dir, root, since, &mut partial)
    };
    for transcript in found {
        cancel.check()?;
        if files >= limits.files
            || transcript.size > limits.file_bytes
            || total.saturating_add(transcript.size) > limits.total_bytes
        {
            partial = true;
            continue;
        }
        files += 1;
        total += transcript.size;
        match File::open(&transcript.path) {
            Ok(file) => read_transcript(file, &mut tally, limits, cancel, &mut partial)?,
            Err(_) => partial = true,
        }
    }

    let mut counts = vec![0u32; unique.len()];
    let mut last: Vec<Option<OffsetDateTime>> = vec![None; unique.len()];
    for (skill, at) in tally.uses.values() {
        if let (Some(count), Some(latest)) = (counts.get_mut(*skill), last.get_mut(*skill)) {
            *count += 1;
            *latest = Some(latest.map_or(*at, |l: OffsetDateTime| l.max(*at)));
        }
    }

    let skills = unique
        .iter()
        .enumerate()
        .map(|(i, (skill, tokens))| {
            let since = tally.first_seen.get(i).copied().flatten();
            let uses = counts.get(i).copied().unwrap_or(0);
            let used_at = last.get(i).copied().flatten();
            SkillUsage {
                name: skill.name.clone(),
                tokens: *tokens,
                usage: since.and_then(|since| {
                    let days = u32::try_from((now - since).whole_days())
                        .unwrap_or(0)
                        .min(WINDOW_DAYS);
                    if uses > 0 {
                        Some(UsageSeen {
                            uses,
                            last_used: used_at.map(crate::time::format),
                            days: days.max(1),
                        })
                    } else if partial || days == 0 {
                        // Uses may be in what was skipped; and less than a day says nothing.
                        None
                    } else {
                        Some(UsageSeen {
                            uses: 0,
                            last_used: None,
                            days,
                        })
                    }
                }),
            }
        })
        .collect();
    Ok(SkillUsageReport { partial, skills })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_follow_claude_code() {
        assert_eq!(
            transcript_folder(Path::new("/Users/me/Workspace/my.app_x")),
            "-Users-me-Workspace-my-app-x"
        );
        assert_eq!(
            transcript_folder(Path::new("/p/.claude/worktrees/feat+a")),
            "-p--claude-worktrees-feat-a"
        );
        assert_eq!(
            transcript_folder(Path::new(r"C:\Users\me\app")),
            "C--Users-me-app"
        );
    }

    #[test]
    fn only_an_opening_tag_is_a_command() {
        assert_eq!(
            command_name("<command-message>x</command-message>\n<command-name>/x</command-name>"),
            Some("x")
        );
        assert_eq!(
            command_name("<command-name>/x</command-name>\n<command-args>a</command-args>"),
            Some("x")
        );
        assert_eq!(
            command_name("<command-message>x</command-message>\n<command-name>x</command-name>"),
            Some("x")
        );
        assert_eq!(
            command_name("what does <command-name>/x</command-name> mean?"),
            None
        );
        assert_eq!(command_name("<command-name>/x"), None);
    }

    #[test]
    fn a_long_line_is_passed_over_and_the_next_one_read() {
        let bytes = b"short\nmuch-too-long-for-the-limit\nnext\nlast";
        let mut reader = &bytes[..];
        let mut line = Vec::new();
        assert_eq!(
            next_line(&mut reader, &mut line, 8).unwrap(),
            Some(true),
            "fits"
        );
        assert_eq!(line, b"short\n");
        assert_eq!(next_line(&mut reader, &mut line, 8).unwrap(), Some(false));
        assert!(line.is_empty());
        assert_eq!(next_line(&mut reader, &mut line, 8).unwrap(), Some(true));
        assert_eq!(line, b"next\n");
        assert_eq!(next_line(&mut reader, &mut line, 8).unwrap(), Some(true));
        assert_eq!(line, b"last");
        assert_eq!(next_line(&mut reader, &mut line, 8).unwrap(), None);
    }
}
