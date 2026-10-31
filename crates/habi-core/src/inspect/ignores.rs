//! The ignore files a walk honours, loaded by hand.
//!
//! `.gitignore` is repository content: a plain clone can deliver one that links
//! to `/dev/zero`, and an unpacked folder one that is a FIFO. So each file is
//! checked to be a regular file and read with a limit before any of it becomes
//! a rule. One that cannot be applied is reported, because the listing may then
//! hold files it should have left out.
//!
//! Precedence is that of the `ignore` crate. `.habiignore` beats `.ignore`,
//! which beats `.gitignore`, which beats `.git/info/exclude`; within one kind
//! the nearest directory that decides wins.

use super::repo;
use crate::cancel::CancelToken;
use crate::fsutil::{Bounded, read_bounded};
use crate::inspect::clip;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::borrow::Cow;
use std::path::{Path, PathBuf};

/// One ignore file. Far above any real one; rules cost time for every path.
const FILE_LIMIT: u64 = 1024 * 1024;
/// All ignore files of one walk together: a directory can have one each.
const TOTAL_LIMIT: u64 = 16 * 1024 * 1024;
/// Gaps kept word for word; the rest are counted.
const MAX_GAPS: usize = 20;
/// Lines that are not patterns, kept to show.
const MAX_PROBLEMS: usize = 100;

/// The files read in each directory, strongest first.
const NAMES: [&str; 3] = [".habiignore", ".ignore", ".gitignore"];
/// `NAMES`, then `.git/info/exclude`.
const KINDS: usize = NAMES.len() + 1;
/// The kinds said to tools like Habi. The others say what Git tracks.
const ASKED_OF_TOOLS: usize = 2;

struct Frame {
    dir: PathBuf,
    rules: [Option<Gitignore>; KINDS],
}

/// The rules of the directories from the top of the repository down to the one
/// being listed. Entries arrive depth first, so one stack is enough.
pub(super) struct IgnoreStack {
    root: PathBuf,
    frames: Vec<Frame>,
    /// Where the walked folder's own frame is.
    base: usize,
    budget: u64,
    cancel: CancelToken,
    gaps: Vec<String>,
    gaps_left_out: usize,
    problems: Vec<String>,
}

impl IgnoreStack {
    pub(super) fn new(root: &Path, cancel: CancelToken) -> Self {
        let mut stack = IgnoreStack {
            root: root.to_path_buf(),
            frames: Vec::new(),
            base: 0,
            budget: TOTAL_LIMIT,
            cancel,
            gaps: Vec::new(),
            gaps_left_out: 0,
            problems: Vec::new(),
        };
        // Above the folder, only its own repository has a say. A `.gitignore`
        // of `*` in a home folder says nothing about a project below it.
        if let Some(top) = repo::enclosing_root(root) {
            let mut above = Vec::new();
            for dir in root.ancestors().skip(1) {
                above.push(dir);
                if dir == top {
                    break;
                }
            }
            for dir in above.into_iter().rev() {
                let frame = stack.frame(dir);
                stack.frames.push(frame);
            }
        }
        stack.base = stack.frames.len();
        let frame = stack.frame(root);
        stack.frames.push(frame);
        stack
    }

    /// Whether the rules say to leave out `path`, an entry `depth` levels below
    /// the walked folder.
    pub(super) fn ignored(&mut self, path: &Path, depth: usize, is_dir: bool) -> bool {
        self.decide(path, depth, is_dir, KINDS)
    }

    /// Whether `.habiignore` or `.ignore` leave out `path`, whatever Git makes of it.
    pub(super) fn asked_to_skip(&mut self, path: &Path, depth: usize, is_dir: bool) -> bool {
        self.decide(path, depth, is_dir, ASKED_OF_TOOLS)
    }

    fn decide(&mut self, path: &Path, depth: usize, is_dir: bool, kinds: usize) -> bool {
        let Some(parent) = path.parent() else {
            return false;
        };
        // The parent's frame sits at `base + depth - 1`. A frame there for
        // another directory is a sibling the walk has finished with.
        let own = self.base + depth;
        self.frames.truncate(own);
        if self.frames.len() == own && self.frames.last().is_some_and(|f| f.dir != parent) {
            self.frames.pop();
        }
        if self.frames.len() < own {
            let frame = self.frame(parent);
            self.frames.push(frame);
        }
        for kind in 0..kinds {
            for frame in self.frames.iter().rev() {
                let Some(rules) = frame.rules.get(kind).and_then(Option::as_ref) else {
                    continue;
                };
                match rules.matched(path, is_dir) {
                    Match::None => {}
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                }
            }
        }
        false
    }

    /// Ignore files that could not be applied, in full or in part.
    pub(super) fn take_gaps(&mut self) -> Vec<String> {
        let mut gaps = std::mem::take(&mut self.gaps);
        if self.gaps_left_out > 0 {
            gaps.push(format!(
                "and {} more ignore files that could not be applied",
                self.gaps_left_out
            ));
        }
        gaps
    }

    /// Lines of ignore files that are not valid patterns. These do not leave
    /// the listing short of anything worth a gap: the line never meant a thing.
    pub(super) fn take_problems(&mut self) -> Vec<String> {
        std::mem::take(&mut self.problems)
    }

    fn frame(&mut self, dir: &Path) -> Frame {
        let [first, second, third] = NAMES.map(|name| self.load(dir, &dir.join(name)));
        let exclude = self.exclude_of(dir);
        Frame {
            dir: dir.to_path_buf(),
            rules: [first, second, third, exclude],
        }
    }

    /// `.git/info/exclude`, in a repository whose `.git` is a real folder. A
    /// linked checkout's `.git` is a file and its exclude file is not read.
    fn exclude_of(&mut self, dir: &Path) -> Option<Gitignore> {
        let is_dir = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
        let info = dir.join(".git").join("info");
        if !is_dir(&dir.join(".git")) || !is_dir(&info) {
            return None;
        }
        self.load(dir, &info.join("exclude"))
    }

    /// The rules in `file`, which apply below `dir`.
    fn load(&mut self, dir: &Path, file: &Path) -> Option<Gitignore> {
        let meta = match std::fs::symlink_metadata(file) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                self.gap(file, &format!("could not be read ({e})"));
                return None;
            }
        };
        // A folder of that name is not an ignore file, for Git either.
        if meta.is_dir() {
            return None;
        }
        // Opening a link to a device or a FIFO could never finish.
        if !meta.is_file() {
            self.gap(file, "is not a regular file");
            return None;
        }
        if meta.len() > FILE_LIMIT {
            self.gap(file, &format!("is above the {FILE_LIMIT}-byte limit"));
            return None;
        }
        if meta.len() > self.budget {
            self.gap(
                file,
                &format!("is past the {TOTAL_LIMIT} bytes of ignore files read in one scan"),
            );
            return None;
        }
        let bytes = match read_bounded(file, FILE_LIMIT) {
            Ok(Bounded::Content(bytes)) => bytes,
            Ok(Bounded::TooLarge(_)) => {
                self.gap(file, &format!("is above the {FILE_LIMIT}-byte limit"));
                return None;
            }
            Err(e) => {
                self.gap(file, &format!("could not be read ({e})"));
                return None;
            }
        };
        self.budget = self.budget.saturating_sub(bytes.len() as u64);
        let text = String::from_utf8_lossy(&bytes);
        if matches!(text, Cow::Owned(_)) {
            // A pattern with a broken character matches nothing; the rest hold.
            self.gap(
                file,
                "is not valid UTF-8, so some of its rules may not hold",
            );
        }
        let mut builder = GitignoreBuilder::new(dir);
        for (i, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
            if i.is_multiple_of(1024) && self.cancel.is_cancelled() {
                return None;
            }
            if let Err(e) = builder.add_line(None, line) {
                self.problem(file, i + 1, &e.to_string());
            }
        }
        match builder.build() {
            Ok(rules) => (!rules.is_empty()).then_some(rules),
            Err(e) => {
                self.gap(file, &format!("could not be used ({e})"));
                None
            }
        }
    }

    fn shown(&self, file: &Path) -> String {
        match file.strip_prefix(&self.root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => crate::paths::display_path(file),
        }
    }

    fn gap(&mut self, file: &Path, why: &str) {
        if self.gaps.len() >= MAX_GAPS {
            self.gaps_left_out += 1;
            return;
        }
        let shown = self.shown(file);
        self.gaps.push(format!(
            "{shown} {} and was not fully applied, so files it would leave out may be listed.",
            clip(why, 200)
        ));
    }

    fn problem(&mut self, file: &Path, line: usize, error: &str) {
        if self.problems.len() < MAX_PROBLEMS {
            let shown = self.shown(file);
            self.problems
                .push(format!("{shown}, line {line}: {}", clip(error, 200)));
        }
    }
}
