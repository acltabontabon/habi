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
//! a skill a session offered, so a folder Claude Code does not read or a skill
//! newer than any session says nothing. A record that names a use but cannot be
//! read makes the whole read partial, which also says nothing of unused skills.
//! The format is Claude Code's own and undocumented, and one change cannot be
//! seen from here: if the `Skill` tool were renamed, its calls would look like
//! any other tool's and skills would read as unused.
//! `docs/dev/compatibility-research.md` records what was checked, and what other
//! agents keep.

use crate::cancel::CancelToken;
use crate::clients::ClientId;
use crate::error::Result;
use crate::inspect::repo::git_pointer;
use crate::skills::intake::DiscoveredSkill;
use crate::suggest::tokens_of;
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs::{self, DirEntry, File};
use std::io::{BufRead, BufReader, Seek};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;
use time::{Duration, OffsetDateTime};
use ts_rs::TS;

/// How far back sessions are read.
pub const WINDOW_DAYS: u32 = 30;

/// Where Claude Code keeps session transcripts, under the home folder.
pub const TRANSCRIPTS_DIR: &str = ".claude/projects";

/// A repository's other checkouts looked for; one with more says so.
const MAX_CHECKOUTS: usize = 64;

/// Lines read at the head of a transcript to find whose it is: a session opens
/// with a few records that name no folder.
const HEAD_LINES: usize = 64;

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
    /// Some transcripts were skipped (a limit, an unreadable file), or a record
    /// that names a use could not be read: uses may be missing, so counts are
    /// minimums and no skill is called unused.
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
    /// The project and the repository's other checkouts.
    roots: &'a [PathBuf],
    cutoff: OffsetDateTime,
    /// Name or folder name to skill. Only skills Claude Code can read.
    watched: HashMap<&'a str, usize>,
    /// By tool call or record id: a resumed session can repeat its records.
    uses: HashMap<String, (usize, OffsetDateTime)>,
    /// Calls that failed. Kept apart from `uses`: files are read newest first,
    /// and an older one can repeat a call after its failure was seen.
    failed: HashSet<String>,
    /// When each skill was last called or typed.
    direct: Vec<Option<OffsetDateTime>>,
    first_seen: Vec<Option<OffsetDateTime>>,
    /// A record named a use and could not be read.
    unreadable: bool,
}

impl Tally<'_> {
    fn in_project(&self, folder: &str) -> bool {
        let folder = Path::new(folder);
        self.roots.iter().any(|root| folder.starts_with(root))
    }

    fn seen(&mut self, skill: usize, at: OffsetDateTime) {
        if let Some(first) = self.first_seen.get_mut(skill) {
            *first = Some(first.map_or(at, |f| f.min(at)));
        }
    }

    fn used(&mut self, id: &str, skill: usize, at: OffsetDateTime, direct: bool) {
        if at < self.cutoff {
            return;
        }
        self.uses.insert(id.to_string(), (skill, at));
        if direct && let Some(last) = self.direct.get_mut(skill) {
            *last = Some(at);
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

    fn agent_calls(&mut self, record: &Value, at: Option<OffsetDateTime>) {
        let blocks = record.pointer("/message/content").and_then(Value::as_array);
        for block in blocks.into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use")
                || block.get("name").and_then(Value::as_str) != Some("Skill")
            {
                continue;
            }
            match (
                block.get("id").and_then(Value::as_str),
                block.pointer("/input/skill").and_then(Value::as_str),
                at,
            ) {
                (Some(id), Some(name), Some(at)) => {
                    if let Some(&skill) = self.watched.get(name) {
                        self.used(id, skill, at, true);
                    }
                }
                _ => self.unreadable = true,
            }
        }
    }

    fn command(&mut self, record: &Value, text: &str, at: Option<OffsetDateTime>) {
        let Some(&skill) = command_name(text).and_then(|name| self.watched.get(name)) else {
            return;
        };
        let (Some(id), Some(at)) = (record.get("uuid").and_then(Value::as_str), at) else {
            self.unreadable = true;
            return;
        };
        // A skill loaded for the session comes as a record the app wrote. Right
        // after a call or a typed command it would be that same load.
        let loaded = record.get("isMeta").and_then(Value::as_bool) == Some(true);
        let last = self.direct.get(skill).copied().flatten();
        if loaded && last.is_some_and(|last| (at - last).abs() <= Duration::minutes(1)) {
            return;
        }
        self.used(id, skill, at, !loaded);
    }

    fn user_turn(&mut self, record: &Value, at: Option<OffsetDateTime>) {
        match record.pointer("/message/content") {
            Some(Value::String(text)) => self.command(record, text, at),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        // Refused, or no such skill: the call is not a use.
                        Some("tool_result")
                            if block.get("is_error").and_then(Value::as_bool) == Some(true) =>
                        {
                            if let Some(call) = block.get("tool_use_id").and_then(Value::as_str) {
                                self.failed.insert(call.to_string());
                            }
                        }
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                self.command(record, text, at);
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
        // A crash or a live append can cut a line short, and this one looks like
        // it may name a use.
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            self.unreadable = true;
            return;
        };
        // Folder names are lossy (`/a/b-c` and `/a/b/c` share one, and `/a/b-c`
        // starts like `/a/b`), so the record's own folder decides.
        let cwd = record.get("cwd").and_then(Value::as_str);
        if cwd.is_some_and(|folder| !self.in_project(folder)) {
            return;
        }
        // Without a folder and a time a use cannot be placed; see `unreadable`.
        let at = cwd.and(
            record
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(crate::time::parse),
        );
        match record.get("type").and_then(Value::as_str) {
            Some("attachment") => {
                if let Some(at) = at {
                    self.offered(&record, at);
                }
            }
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

/// The path a small Git file points to, after `prefix`, resolved from `base`.
/// `None` for a place on another machine (see `git_pointer`): even looking
/// there would offer it the person's credentials.
fn pointed_at(file: &Path, base: &Path, prefix: &str) -> Option<PathBuf> {
    fs::symlink_metadata(file).ok().filter(|m| m.is_file())?;
    let bytes = crate::fsutil::read_prefix(file, 4096).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let path = git_pointer(base, text.trim().strip_prefix(prefix)?)?;
    Some(crate::paths::canonical(&path).unwrap_or(path))
}

/// Whether a checkout and an entry of `.git/worktrees` name each other. Either
/// file can be anything in a folder someone sent; alone it could call every
/// session under some other tree this project's. Git requires both, and so does
/// this: the entry's `gitdir` names the checkout's `.git` file, and that file
/// names the entry.
fn linked_both_ways(admin: &Path, dot_git: &Path) -> bool {
    let same = |a: &Path, b: &Path| {
        let canonical = |p: &Path| crate::paths::canonical(p).unwrap_or_else(|_| p.to_path_buf());
        canonical(a) == canonical(b)
    };
    let Some(checkout) = dot_git.parent() else {
        return false;
    };
    dot_git.file_name().is_some_and(|name| name == ".git")
        && pointed_at(&admin.join("gitdir"), admin, "").is_some_and(|d| same(&d, dot_git))
        && pointed_at(dot_git, checkout, "gitdir:").is_some_and(|a| same(&a, admin))
}

/// The project and the repository's other checkouts, wherever they are. Sessions
/// in any of them can use the project's skills, and a checkout beside the
/// project is nothing its folder name would give away. Read from the files Git
/// keeps them in (`.git/worktrees/<id>/gitdir`); Git is not run.
fn checkouts(root: &Path, partial: &mut bool) -> Vec<PathBuf> {
    let mut found = vec![root.to_path_buf()];
    let dot_git = root.join(".git");
    let Ok(meta) = fs::symlink_metadata(&dot_git) else {
        return found;
    };
    let common = if meta.is_dir() {
        dot_git
    } else {
        // A linked checkout's `.git` is a file: `gitdir: <common>/worktrees/<id>`.
        // A submodule's looks the same but does not go through `worktrees`.
        let admin = pointed_at(&dot_git, root, "gitdir:");
        let common = admin
            .as_deref()
            .and_then(Path::parent)
            .and_then(|parent| (parent.file_name()? == "worktrees").then(|| parent.parent())?);
        let Some(common) = common else {
            return found;
        };
        if !admin
            .as_deref()
            .is_some_and(|a| linked_both_ways(a, &dot_git))
        {
            return found;
        }
        // A bare repository has no checkout of its own, and what is beside it is
        // nothing to do with it.
        if common.file_name().is_some_and(|name| name == ".git") {
            found.extend(common.parent().map(Path::to_path_buf));
        }
        common.to_path_buf()
    };
    let linked = entries(&common.join("worktrees"), partial);
    *partial |= linked.len() > MAX_CHECKOUTS;
    for entry in linked.iter().filter(|e| is_dir(e)).take(MAX_CHECKOUTS) {
        let admin = entry.path();
        // `gitdir` names the checkout's `.git` file.
        if let Some(dot_git) = pointed_at(&admin.join("gitdir"), &admin, "")
            && linked_both_ways(&admin, &dot_git)
        {
            found.extend(dot_git.parent().map(Path::to_path_buf));
        }
    }
    // Sorted, a folder comes before what is inside it, which it already covers.
    found.sort();
    let mut kept: Vec<PathBuf> = Vec::new();
    for path in found {
        if !kept.iter().any(|k| path.starts_with(k)) {
            kept.push(path);
        }
    }
    kept
}

/// Transcripts from the folders of sessions started in a checkout or below it (a
/// subfolder, a worktree under `.claude/worktrees`), the newest first. Folder
/// names are lossy, so this also lists sessions of other projects whose path
/// starts alike (`/a/b-c` for `/a/b`); `starts_elsewhere` puts those down.
fn transcripts(
    dir: &Path,
    roots: &[PathBuf],
    since: SystemTime,
    partial: &mut bool,
) -> Vec<Transcript> {
    let folders: Vec<String> = roots.iter().map(|r| transcript_folder(r)).collect();
    let mut out = Vec::new();
    for entry in entries(dir, partial) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let wanted = folders.iter().any(|folder| {
            name.strip_prefix(folder.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
        });
        if !is_dir(&entry) || !wanted {
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

/// Whether a transcript belongs to another project: its first record that names
/// a folder is outside this one. Nothing else is taken from it, and it is read
/// no further. A transcript that does not say within its first lines is read.
fn starts_elsewhere(reader: &mut impl BufRead, tally: &Tally<'_>, limits: &UsageLimits) -> bool {
    let mut line = Vec::new();
    for _ in 0..HEAD_LINES {
        match next_line(reader, &mut line, limits.line_bytes) {
            Ok(Some(true)) => {
                let folder = serde_json::from_slice::<Value>(&line)
                    .ok()
                    .and_then(|record| Some(record.get("cwd")?.as_str()?.to_string()));
                if let Some(folder) = folder {
                    return !tally.in_project(&folder);
                }
            }
            Ok(Some(false)) => {}
            Ok(None) | Err(_) => return false,
        }
    }
    false
}

fn read_transcript(
    reader: &mut impl BufRead,
    tally: &mut Tally<'_>,
    limits: &UsageLimits,
    cancel: &CancelToken,
    partial: &mut bool,
) -> Result<()> {
    let mut line = Vec::new();
    let mut read: u32 = 0;
    loop {
        match next_line(reader, &mut line, limits.line_bytes) {
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
    let readable = || {
        unique
            .iter()
            .enumerate()
            .filter(|(_, (skill, _))| skill.readers.contains(&ClientId::ClaudeCode))
    };
    let mut watched: HashMap<&str, usize> = readable()
        .map(|(i, (skill, _))| (skill.name.as_str(), i))
        .collect();
    // Agents may go by the folder where `name` differs from it, but a skill of
    // that name keeps its own uses.
    for (i, (skill, _)) in readable() {
        if let Some(folder) = skill.path.rsplit('/').next() {
            watched.entry(folder).or_insert(i);
        }
    }

    let mut partial = false;
    // With nothing to look for, no transcript is opened at all.
    let nothing = watched.is_empty();
    let roots = if nothing {
        Vec::new()
    } else {
        checkouts(root, &mut partial)
    };
    let mut tally = Tally {
        roots: &roots,
        cutoff,
        watched,
        uses: HashMap::new(),
        failed: HashSet::new(),
        direct: vec![None; unique.len()],
        first_seen: vec![None; unique.len()],
        unreadable: false,
    };

    let since = SystemTime::from(cutoff);
    let mut total: u64 = 0;
    let mut files: usize = 0;
    let found = if nothing {
        Vec::new()
    } else {
        transcripts(dir, &roots, since, &mut partial)
    };
    for transcript in found {
        cancel.check()?;
        if files >= limits.files {
            partial = true;
            continue;
        }
        files += 1;
        let Ok(file) = File::open(&transcript.path) else {
            partial = true;
            continue;
        };
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        // Another project's costs none of the budget, which is for this one.
        if starts_elsewhere(&mut reader, &tally, limits) {
            continue;
        }
        if transcript.size > limits.file_bytes
            || total.saturating_add(transcript.size) > limits.total_bytes
        {
            partial = true;
            continue;
        }
        total += transcript.size;
        if reader.rewind().is_err() {
            partial = true;
            continue;
        }
        read_transcript(&mut reader, &mut tally, limits, cancel, &mut partial)?;
    }

    partial |= tally.unreadable;
    let Tally {
        mut uses,
        failed,
        mut first_seen,
        ..
    } = tally;
    uses.retain(|id, _| !failed.contains(id));
    // Only now: a refused call is no sign a session had the skill at all.
    for (skill, at) in uses.values() {
        if let Some(first) = first_seen.get_mut(*skill) {
            *first = Some(first.map_or(*at, |f| f.min(*at)));
        }
    }

    let mut counts = vec![0u32; unique.len()];
    let mut last: Vec<Option<OffsetDateTime>> = vec![None; unique.len()];
    for (skill, at) in uses.values() {
        if let (Some(count), Some(latest)) = (counts.get_mut(*skill), last.get_mut(*skill)) {
            *count += 1;
            *latest = Some(latest.map_or(*at, |l: OffsetDateTime| l.max(*at)));
        }
    }

    let skills = unique
        .iter()
        .enumerate()
        .map(|(i, (skill, tokens))| {
            let since = first_seen.get(i).copied().flatten();
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
    fn a_read_stops_partway_through_a_file_when_cancelled() {
        // A use on every line: past the first check, nothing more may be counted.
        let mut text = String::new();
        for i in 0..10_000 {
            text.push_str(&format!(
                r#"{{"type":"assistant","cwd":"/p","timestamp":"2026-10-01T00:00:00Z","message":{{"content":[{{"type":"tool_use","id":"t{i}","name":"Skill","input":{{"skill":"x"}}}}]}}}}"#
            ));
            text.push('\n');
        }
        let roots = [PathBuf::from("/p")];
        let mut tally = Tally {
            roots: &roots,
            cutoff: OffsetDateTime::UNIX_EPOCH,
            watched: HashMap::from([("x", 0)]),
            uses: HashMap::new(),
            failed: HashSet::new(),
            direct: vec![None],
            first_seen: vec![None],
            unreadable: false,
        };
        let cancel = CancelToken::new();
        cancel.cancel();
        let mut partial = false;
        let result = read_transcript(
            &mut text.as_bytes(),
            &mut tally,
            &UsageLimits::DEFAULT,
            &cancel,
            &mut partial,
        );
        assert!(matches!(result, Err(crate::error::HabiError::Cancelled)));
        assert!(!tally.uses.is_empty(), "it had started");
        assert!(tally.uses.len() < 10_000, "and it stopped");
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
