//! Reading a project's skill use from synthetic Claude Code transcripts
//! (`fixtures/transcripts`). The home folder is always a temporary one.

mod common;

use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::error::HabiError;
use habi_core::service::Habi;
use habi_core::skills::intake::DiscoveredSkill;
use habi_core::store::AppPaths;
use habi_core::usage::{SkillUsage, SkillUsageReport, UsageLimits, read_usage, transcript_folder};
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tempfile::TempDir;
use time::OffsetDateTime;

/// A project next to its lookalike (`my-app` and `my/app` share a transcript folder).
struct World {
    _temp: TempDir,
    home: PathBuf,
    project: PathBuf,
    lookalike: PathBuf,
}

impl World {
    fn new() -> World {
        let temp = tempfile::tempdir().unwrap();
        let base = habi_core::paths::canonical(temp.path()).unwrap();
        let (home, project, lookalike) = (
            base.join("home"),
            base.join("work/my-app"),
            base.join("work/my/app"),
        );
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        World {
            _temp: temp,
            home,
            project,
            lookalike,
        }
    }

    fn transcripts(&self) -> PathBuf {
        self.home.join(".claude/projects")
    }

    /// The project's transcript folder, or the one named with `suffix` after it.
    fn folder(&self, suffix: &str) -> PathBuf {
        self.transcripts()
            .join(format!("{}{suffix}", transcript_folder(&self.project)))
    }

    fn render(&self, text: &str) -> String {
        let quoted = |p: &Path| {
            let json = serde_json::to_string(&p.to_string_lossy()).unwrap();
            json.trim_matches('"').to_string()
        };
        let text = text
            .replace("{{project}}", &quoted(&self.project))
            .replace("{{lookalike}}", &quoted(&self.lookalike));
        Regex::new(r"\{\{days_ago:(\d+)\}\}")
            .unwrap()
            .replace_all(&text, |c: &regex::Captures<'_>| {
                let days: i64 = c[1].parse().unwrap();
                habi_core::time::format(OffsetDateTime::now_utc() - time::Duration::days(days))
            })
            .into_owned()
    }

    /// Copies one fixture folder, rendered, into a transcript folder.
    fn copy(&self, fixture: &str, to: &Path) {
        fn walk(world: &World, from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    walk(world, &entry.path(), &target);
                } else {
                    let text = fs::read_to_string(entry.path()).unwrap();
                    fs::write(target, world.render(&text)).unwrap();
                }
            }
        }
        walk(
            self,
            &common::fixture(&format!("transcripts/{fixture}")),
            to,
        );
    }

    fn all_fixtures(&self) {
        self.copy("project", &self.folder(""));
        self.copy("lookalike", &self.folder(""));
        self.copy("worktree", &self.folder("--claude-worktrees-feature"));
        self.copy("sibling", &self.folder("-two"));
    }

    fn write(&self, session: &str, text: &str) {
        fs::create_dir_all(self.folder("")).unwrap();
        fs::write(self.folder("").join(session), self.render(text)).unwrap();
    }

    fn read(&self, skills: &[DiscoveredSkill], limits: &UsageLimits) -> SkillUsageReport {
        read_usage(
            &self.transcripts(),
            &self.project,
            skills,
            OffsetDateTime::now_utc(),
            limits,
            &CancelToken::new(),
        )
        .unwrap()
    }
}

fn skill(name: &str) -> DiscoveredSkill {
    DiscoveredSkill {
        path: format!(".claude/skills/{name}"),
        name: name.to_string(),
        description: "Does one thing well.".to_string(),
        readers: vec![ClientId::ClaudeCode],
        managed_by: None,
        has_metadata: false,
        file_count: 1,
        problems: Vec::new(),
        digest: String::new(),
        imported_as: None,
    }
}

fn entry<'a>(report: &'a SkillUsageReport, name: &str) -> &'a SkillUsage {
    report
        .skills
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("{name} is reported"))
}

fn uses(report: &SkillUsageReport, name: &str) -> Option<u32> {
    entry(report, name).usage.as_ref().map(|u| u.uses)
}

fn days(report: &SkillUsageReport, name: &str) -> Option<u32> {
    entry(report, name).usage.as_ref().map(|u| u.days)
}

const LISTING: &str = r#"{"attachment":{"type":"skill_listing","names":["alpha"]},"type":"attachment","uuid":"l1","timestamp":"{{days_ago:9}}","cwd":"{{project}}"}"#;
const CALL: &str = r#"{"message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"alpha"}}]},"type":"assistant","uuid":"c1","timestamp":"{{days_ago:1}}","cwd":"{{project}}"}"#;

fn write_skill(project: &Path, folder: &str, name: &str, description: &str) {
    let dir = project.join(folder).join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
    )
    .unwrap();
}

#[test]
fn the_service_says_what_the_transcripts_show() {
    let world = World::new();
    world.all_fixtures();
    for name in [
        "migration-review",
        "release-notes",
        "changelog-style",
        "stale-helper",
        "never-offered",
    ] {
        write_skill(
            &world.project,
            ".claude/skills",
            name,
            "Does one thing well.",
        );
    }
    write_skill(
        &world.project,
        ".agents/skills",
        "agents-only",
        "For other agents.",
    );

    let data = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(data.path().to_path_buf()))
        .unwrap()
        .with_user_home(world.home.clone());
    let project = habi.open_project(&world.project).unwrap();
    let report = habi.skill_usage(&project.id, &CancelToken::new()).unwrap();

    assert!(!report.partial);
    // Two calls, one by a subagent; one resumed session repeats a call, and it counts once.
    let used = entry(&report, "migration-review").usage.clone().unwrap();
    assert_eq!(used.uses, 3);
    assert_eq!(used.days, 20, "since a session first offered it");
    let last = habi_core::time::parse(&used.last_used.unwrap()).unwrap();
    assert_eq!((OffsetDateTime::now_utc() - last).whole_days(), 1);
    // Typed in the session and in the resumed one, and called from a worktree.
    assert_eq!(uses(&report, "release-notes"), Some(3));

    // A refused call is no use, so it was offered and not used.
    assert_eq!(uses(&report, "changelog-style"), Some(0));
    assert_eq!(days(&report, "changelog-style"), Some(20));
    // Everything that only looks like a use: a mention, a plugin's skill, another tool, a call
    // from before the window, a cut-off line, a compaction's note, and other folders' sessions.
    assert_eq!(uses(&report, "stale-helper"), Some(0));
    let unused = entry(&report, "stale-helper").usage.clone().unwrap();
    assert_eq!(unused.last_used, None);

    // Never offered: nothing to go on, which is not the same as unused.
    assert!(entry(&report, "never-offered").usage.is_none());
    // Claude Code does not read that folder, whatever a transcript says of the name.
    assert!(entry(&report, "agents-only").usage.is_none());
    assert_eq!(
        entry(&report, "agents-only").tokens,
        habi_core::suggest::tokens_of("agents-only", "For other agents.")
    );
}

#[test]
fn no_transcripts_says_nothing_but_still_estimates_context() {
    let world = World::new();
    let report = world.read(&[skill("alpha")], &UsageLimits::DEFAULT);
    assert!(!report.partial);
    assert!(entry(&report, "alpha").usage.is_none());
    assert_eq!(entry(&report, "alpha").tokens, 7);
}

#[test]
fn a_skill_with_no_description_costs_nothing() {
    let world = World::new();
    let bare = DiscoveredSkill {
        description: "  ".into(),
        ..skill("alpha")
    };
    let report = world.read(&[bare], &UsageLimits::DEFAULT);
    assert_eq!(entry(&report, "alpha").tokens, 0);
}

#[test]
fn with_no_skill_claude_code_reads_no_transcript_is_opened() {
    let world = World::new();
    world.write("s.jsonl", &format!("{LISTING}\n{CALL}\n"));
    let elsewhere = DiscoveredSkill {
        path: ".agents/skills/alpha".into(),
        readers: vec![ClientId::Codex],
        ..skill("alpha")
    };
    // A limit of no files at all makes any attempt to read show as a partial read.
    let none = UsageLimits {
        files: 0,
        ..UsageLimits::DEFAULT
    };
    assert!(
        world.read(&[skill("alpha")], &none).partial,
        "the probe works"
    );
    let report = world.read(&[elsewhere], &none);
    assert!(!report.partial);
    assert!(entry(&report, "alpha").usage.is_none());
}

#[test]
fn a_skill_in_several_folders_is_one_skill() {
    let world = World::new();
    world.write("s.jsonl", &format!("{LISTING}\n{CALL}\n"));
    let other = DiscoveredSkill {
        path: ".agents/skills/alpha".into(),
        readers: vec![ClientId::Codex],
        description: "Does one thing well, at some length, in this copy.".into(),
        ..skill("alpha")
    };
    let report = world.read(&[other, skill("alpha")], &UsageLimits::DEFAULT);
    assert_eq!(report.skills.len(), 1);
    assert_eq!(uses(&report, "alpha"), Some(1));
    assert_eq!(entry(&report, "alpha").tokens, 14, "the larger entry");
}

#[test]
fn a_folder_name_that_differs_from_name_still_counts() {
    let world = World::new();
    let renamed = DiscoveredSkill {
        path: ".claude/skills/alpha".into(),
        ..skill("Alpha Reviews")
    };
    world.write("s.jsonl", &format!("{LISTING}\n{CALL}\n"));
    let report = world.read(&[renamed], &UsageLimits::DEFAULT);
    assert_eq!(uses(&report, "Alpha Reviews"), Some(1));
}

#[test]
fn less_than_a_day_of_history_does_not_call_a_skill_unused() {
    let world = World::new();
    world.write(
        "s.jsonl",
        &format!("{}\n", LISTING.replace("{{days_ago:9}}", "{{days_ago:0}}")),
    );
    let report = world.read(&[skill("alpha")], &UsageLimits::DEFAULT);
    assert!(entry(&report, "alpha").usage.is_none());
}

#[test]
fn a_session_that_began_before_the_window_covers_all_of_it() {
    let world = World::new();
    world.write(
        "s.jsonl",
        &format!("{}\n", LISTING.replace("{{days_ago:9}}", "{{days_ago:45}}")),
    );
    let report = world.read(&[skill("alpha")], &UsageLimits::DEFAULT);
    assert_eq!(uses(&report, "alpha"), Some(0));
    assert_eq!(days(&report, "alpha"), Some(30));
}

#[test]
fn a_transcript_not_touched_in_the_window_is_not_opened() {
    let world = World::new();
    world.write("old.jsonl", &format!("{LISTING}\n{CALL}\n"));
    let file = fs::File::options()
        .write(true)
        .open(world.folder("").join("old.jsonl"))
        .unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(40 * 86_400))
        .unwrap();
    drop(file);
    let report = world.read(&[skill("alpha")], &UsageLimits::DEFAULT);
    assert!(entry(&report, "alpha").usage.is_none());
}

#[cfg(unix)]
#[test]
fn links_are_not_followed() {
    use std::os::unix::fs::symlink;
    let world = World::new();
    let outside = world.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        outside.join("linked.jsonl"),
        world.render(&format!("{LISTING}\n{CALL}\n")),
    )
    .unwrap();
    fs::create_dir_all(world.folder("").join("session/.keep")).unwrap();
    // A link to a file, to a project folder, to a session folder, and to `subagents`.
    symlink(
        outside.join("linked.jsonl"),
        world.folder("").join("linked.jsonl"),
    )
    .unwrap();
    symlink(&outside, world.folder("-linked")).unwrap();
    symlink(&outside, world.folder("").join("linked-session")).unwrap();
    symlink(&outside, world.folder("").join("session/subagents")).unwrap();

    let report = world.read(&[skill("alpha")], &UsageLimits::DEFAULT);
    assert!(!report.partial);
    assert!(entry(&report, "alpha").usage.is_none());
}

#[test]
fn what_is_skipped_makes_counts_minimums_and_no_skill_unused() {
    let unused = skill("beta");
    let world = World::new();
    world.write("big.jsonl", &format!("{LISTING}\n{CALL}\n"));
    let beta = r#"{"attachment":{"type":"skill_listing","names":["beta"]},"type":"attachment","uuid":"l2","timestamp":"{{days_ago:9}}","cwd":"{{project}}"}"#;
    world.write("small.jsonl", &format!("{beta}\n{CALL}\n"));
    let size = fs::metadata(world.folder("").join("small.jsonl"))
        .unwrap()
        .len();
    let skills = [skill("alpha"), unused];

    // Each limit, on its own, leaves a call counted and "beta" (offered, not used) unsaid.
    let file_bytes = UsageLimits {
        file_bytes: size,
        ..UsageLimits::DEFAULT
    };
    let total_bytes = UsageLimits {
        total_bytes: size,
        ..UsageLimits::DEFAULT
    };
    let files = UsageLimits {
        files: 1,
        ..UsageLimits::DEFAULT
    };
    for limits in [file_bytes, total_bytes, files] {
        let report = world.read(&skills, &limits);
        assert!(report.partial, "{limits:?}");
        assert_eq!(uses(&report, "alpha"), Some(1), "{limits:?}");
        assert!(entry(&report, "beta").usage.is_none(), "{limits:?}");
    }

    // A line too long to hold is passed over, and the lines after it are still read.
    let long = format!("{{\"padding\":\"{}\"}}\n", "x".repeat(4096));
    world.write("big.jsonl", &format!("{long}{CALL}\n"));
    let report = world.read(
        &skills,
        &UsageLimits {
            line_bytes: 1024,
            ..UsageLimits::DEFAULT
        },
    );
    assert!(report.partial);
    assert_eq!(uses(&report, "alpha"), Some(1));
    assert!(entry(&report, "beta").usage.is_none());
}

#[test]
fn a_cancelled_read_stops() {
    let world = World::new();
    world.all_fixtures();
    let cancel = CancelToken::new();
    cancel.cancel();
    let result = read_usage(
        &world.transcripts(),
        &world.project,
        &[skill("migration-review")],
        OffsetDateTime::now_utc(),
        &UsageLimits::DEFAULT,
        &cancel,
    );
    assert!(matches!(result, Err(HabiError::Cancelled)));
}
