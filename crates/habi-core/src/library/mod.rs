//! Turning a library snapshot (a set of files) into an index of items.
//!
//! A skill is any directory containing `SKILL.md` (Agent Skills format). An
//! optional `habi.yaml` next to it adds Habi metadata. The library may have
//! a `habi-library.yaml` manifest describing the library and declaring
//! portable instructions. Content is never executed or rewritten here.

pub mod model;
pub mod provenance;
pub mod schema;
pub mod signals;
pub mod summary;

use crate::clients::ClientId;
use crate::fsutil::tree_digest;
use crate::matching::Scope;
use crate::matching::condition::Condition;
use model::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SKILL_FILE: &str = "SKILL.md";
pub const SIDECAR_FILES: &[&str; 2] = &["habi.yaml", "habi.yml"];
pub const MANIFEST_FILES: &[&str; 2] = &["habi-library.yaml", "habi-library.yml"];
const METADATA_LIMIT: usize = 256 * 1024;

/// YAML frontmatter fields defined by the Agent Skills specification.
#[derive(Debug, Clone, Default)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub raw: serde_json::Map<String, Value>,
}

pub fn yaml_options() -> serde_saphyr::Options {
    serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_nodes: 20_000,
            max_depth: 32,
            max_aliases: 100,
            max_anchors: 100,
            max_total_scalar_bytes: 1024 * 1024,
        },
    }
}

/// Parses YAML into JSON values with tight resource limits.
pub fn parse_yaml(text: &str) -> Result<Value, String> {
    if text.len() > METADATA_LIMIT {
        return Err(format!("larger than {METADATA_LIMIT} bytes"));
    }
    serde_saphyr::from_str_with_options::<Value>(text, yaml_options()).map_err(|e| {
        // Keep the first line: the full message may echo content.
        e.to_string()
            .lines()
            .next()
            .unwrap_or("invalid YAML")
            .to_string()
    })
}

/// Splits `---\n<yaml>\n---\n<body>` into the YAML text and the body,
/// without parsing the YAML.
#[allow(
    clippy::string_slice,
    reason = "bounds come from find() of ASCII `---` delimiters in the same string"
)]
pub fn split_frontmatter(text: &str) -> Result<(&str, &str), String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Err("SKILL.md does not start with YAML frontmatter (`---`)".into());
    };
    let mut offset = 0;
    let mut end = None;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let (yaml_end, body_start) = end.ok_or("SKILL.md frontmatter is not closed with `---`")?;
    Ok((&rest[..yaml_end], &rest[body_start..]))
}

/// Splits `---\n<yaml>\n---\n<body>` and parses the YAML part.
pub fn parse_frontmatter(text: &str) -> Result<(Frontmatter, &str), String> {
    let (yaml, body) = split_frontmatter(text)?;
    let value = if yaml.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        parse_yaml(yaml).map_err(|e| format!("SKILL.md frontmatter is not valid YAML: {e}"))?
    };
    let raw = match value {
        Value::Object(m) => m,
        _ => return Err("SKILL.md frontmatter must be a mapping".into()),
    };
    let text_field = |k: &str| {
        raw.get(k)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
    };
    Ok((
        Frontmatter {
            name: text_field("name"),
            description: text_field("description"),
            license: text_field("license"),
            compatibility: text_field("compatibility"),
            raw: raw.clone(),
        },
        body,
    ))
}

/// Validates a skill name against the Agent Skills rules.
pub fn check_skill_name(name: &str) -> Result<(), String> {
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if name.is_empty() || name.len() > 64 {
        Err("must be 1–64 characters".into())
    } else if !ok_chars {
        Err("may contain only lowercase letters, digits and hyphens".into())
    } else if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        Err("may not start or end with a hyphen or contain `--`".into())
    } else {
        Ok(())
    }
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn parse_condition(
    v: &Value,
    key: &str,
    path: &str,
    diags: &mut Vec<Diagnostic>,
) -> Option<Condition> {
    let c = v.get(key)?;
    match Condition::parse(c) {
        Ok(c) => Some(c),
        Err(e) => {
            diags.push(Diagnostic::error(format!("`{key}`: {e}"), Some(path)));
            None
        }
    }
}

/// Typed view of a validated sidecar (or manifest instruction entry).
#[derive(Default)]
pub struct Metadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub kind: Option<ItemKind>,
    pub owner: Option<String>,
    pub requirement: Requirement,
    pub priority: i32,
    pub scope: Scope,
    pub applies_when: Option<Condition>,
    pub excludes: Option<Condition>,
    pub tools: Vec<ToolRequirement>,
    pub mcp: Vec<McpRequirement>,
    pub clients: Option<Vec<ClientId>>,
    pub workflow: Option<WorkflowSpec>,
    pub bindings: Vec<BindingSpec>,
    pub checks: Vec<CheckSpec>,
    pub evidence: Vec<DeclaredEvidence>,
    pub examples: Vec<Example>,
}

/// Reads metadata fields from a schema-valid JSON value.
pub fn read_metadata(v: &Value, path: &str, diags: &mut Vec<Diagnostic>) -> Metadata {
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let requires = v.get("requires");
    let tools = requires
        .and_then(|r| r.get("tools"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| ToolRequirement {
                    name: str_field(t, "name").unwrap_or_default(),
                    commands: strings(t.get("commands")),
                    purpose: str_field(t, "purpose"),
                    install_hint: str_field(t, "install_hint"),
                })
                .collect()
        })
        .unwrap_or_default();
    let mcp = requires
        .and_then(|r| r.get("mcp"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|m| McpRequirement {
                    name: str_field(m, "name").unwrap_or_default(),
                    purpose: str_field(m, "purpose"),
                    server: m.get("server").map(|s| {
                        if let Some(url) = str_field(s, "url") {
                            McpServerSpec::Http {
                                url,
                                bearer_token_env: str_field(s, "bearer_token_env"),
                            }
                        } else {
                            McpServerSpec::Stdio {
                                command: str_field(s, "command").unwrap_or_default(),
                                args: strings(s.get("args")),
                                env: s
                                    .get("env")
                                    .and_then(Value::as_object)
                                    .map(|o| {
                                        o.iter()
                                            .filter_map(|(k, v)| {
                                                Some((k.clone(), v.as_str()?.to_string()))
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                            }
                        }
                    }),
                })
                .collect()
        })
        .unwrap_or_default();
    let clients = requires.and_then(|r| r.get("clients")).map(|c| {
        strings(Some(c))
            .iter()
            .filter_map(|s| ClientId::from_slug(s))
            .collect()
    });
    let workflow = v.get("workflow").map(|w| WorkflowSpec {
        steps: w
            .get("steps")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|s| WorkflowStep {
                        title: str_field(s, "title").unwrap_or_default(),
                        detail: str_field(s, "detail"),
                        references: strings(s.get("references")),
                        expected: str_field(s, "expected"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        artifacts: strings(w.get("artifacts")),
    });
    let bindings: Vec<BindingSpec> = v
        .get("bindings")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|b| BindingSpec {
                    name: str_field(b, "name").unwrap_or_default(),
                    kind: if str_field(b, "kind").as_deref() == Some("module") {
                        BindingKind::Module
                    } else {
                        BindingKind::File
                    },
                    glob: str_field(b, "glob"),
                    description: str_field(b, "description"),
                })
                .collect()
        })
        .unwrap_or_default();
    let checks: Vec<CheckSpec> = v
        .get("checks")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|c| CheckSpec {
                    id: str_field(c, "id").unwrap_or_default(),
                    title: str_field(c, "title").unwrap_or_default(),
                    description: str_field(c, "description"),
                    run: c
                        .get("run")
                        .and_then(Value::as_array)
                        .map(|args| {
                            args.iter()
                                .map(|arg| match arg {
                                    Value::String(s) => CheckArg::Literal { value: s.clone() },
                                    other => CheckArg::Binding {
                                        name: str_field(other, "binding").unwrap_or_default(),
                                    },
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    cwd: if str_field(c, "cwd").as_deref() == Some("repository") {
                        CheckCwd::Repository
                    } else {
                        CheckCwd::Module
                    },
                    timeout_seconds: c
                        .get("timeout_seconds")
                        .and_then(Value::as_u64)
                        .unwrap_or(300)
                        .min(3600) as u32,
                })
                .collect()
        })
        .unwrap_or_default();
    // Bindings referenced by checks must be declared.
    for check in &checks {
        for arg in &check.run {
            if let CheckArg::Binding { name } = arg
                && !bindings.iter().any(|b| &b.name == name)
            {
                diags.push(Diagnostic::error(
                    format!("check `{}` uses undeclared binding `{name}`", check.id),
                    Some(path),
                ));
            }
        }
    }
    let evidence = v
        .get("evidence")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| DeclaredEvidence {
                    date: str_field(e, "date").unwrap_or_default(),
                    result: str_field(e, "result").unwrap_or_default(),
                    environment: str_field(e, "environment"),
                    summary: str_field(e, "summary"),
                    by: str_field(e, "by"),
                })
                .collect()
        })
        .unwrap_or_default();
    let examples = v
        .get("examples")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| Example {
                    title: str_field(e, "title").unwrap_or_default(),
                    description: str_field(e, "description"),
                    path: str_field(e, "path"),
                })
                .collect()
        })
        .unwrap_or_default();

    Metadata {
        id: str_field(v, "id"),
        title: str_field(v, "title"),
        kind: match str_field(v, "kind").as_deref() {
            Some("workflow") => Some(ItemKind::Workflow),
            Some("skill") => Some(ItemKind::Skill),
            _ => None,
        },
        owner: str_field(v, "owner"),
        requirement: if str_field(v, "requirement").as_deref() == Some("required") {
            Requirement::Required
        } else {
            Requirement::Recommended
        },
        priority: v.get("priority").and_then(Value::as_i64).unwrap_or(0) as i32,
        scope: if str_field(v, "scope").as_deref() == Some("repository") {
            Scope::Repository
        } else {
            Scope::Module
        },
        applies_when: parse_condition(v, "applies_when", path, diags),
        excludes: parse_condition(v, "excludes", path, diags),
        tools,
        mcp,
        clients,
        workflow,
        bindings,
        checks,
        evidence,
        examples,
    }
}

/// Whether a file name is a licence file: `LICENSE`, `LICENCE`, `COPYING`,
/// `UNLICENSE` or a variant such as `LICENSE-MIT` or `LICENSE.txt`.
pub fn is_license_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let (stem, ext) = match lower.rsplit_once('.') {
        Some((s, e)) => (s, e),
        None => (lower.as_str(), ""),
    };
    let stem_ok = ["license", "licence", "copying", "unlicense"]
        .iter()
        .any(|s| stem == *s || stem.starts_with(&format!("{s}-")));
    stem_ok && matches!(ext, "" | "md" | "txt" | "rst")
}

/// Whether a declared licence says the content is proprietary. Only what the
/// author declared counts; licence texts are not interpreted.
pub fn is_restricted_license(declared: &str) -> bool {
    declared.to_ascii_lowercase().contains("proprietary")
}

/// The nearest licence file at or above `dir` (library-relative).
fn nearest_license(dir: &str, license_files: &BTreeMap<String, Vec<String>>) -> Option<String> {
    let mut current = dir;
    loop {
        if let Some(name) = license_files.get(current).and_then(|names| names.first()) {
            return Some(join(current, name));
        }
        if current.is_empty() {
            return None;
        }
        current = dir_of(current);
    }
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Builds the index for a snapshot. `read` returns a file's bytes by its
/// library-relative path.
pub fn build_index(
    source_id: &str,
    snapshot: &str,
    files: &[SnapshotFile],
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> LibraryIndex {
    let mut index = LibraryIndex {
        source_id: source_id.to_string(),
        snapshot: snapshot.to_string(),
        name: None,
        owner: None,
        description: None,
        contact: None,
        items: Vec::new(),
        diagnostics: Vec::new(),
    };
    let by_path: HashMap<&str, &SnapshotFile> =
        files.iter().map(|f| (f.path.as_str(), f)).collect();
    // Licence files by folder, so each item can point at the nearest one.
    let mut license_files: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in files {
        let name = f.path.rsplit('/').next().unwrap_or(&f.path);
        if is_license_file(name) {
            license_files
                .entry(dir_of(&f.path).to_string())
                .or_default()
                .push(name.to_string());
        }
    }
    for names in license_files.values_mut() {
        names.sort();
    }
    let read_text = |path: &str| -> Result<String, String> {
        let bytes = read(path)?;
        if bytes.len() > METADATA_LIMIT * 4 {
            return Err(format!("{path} is too large to read as metadata"));
        }
        String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8"))
    };

    // Library manifest.
    let mut skills_root = String::new();
    let mut manifest_instructions: Vec<Value> = Vec::new();
    if let Some(manifest_path) = MANIFEST_FILES.iter().find(|m| by_path.contains_key(**m)) {
        match read_text(manifest_path).and_then(|t| parse_yaml(&t)) {
            Ok(value) => match schema::validate_library(&value) {
                Ok(()) => {
                    index.name = str_field(&value, "name");
                    index.owner = str_field(&value, "owner");
                    index.description = str_field(&value, "description");
                    index.contact = str_field(&value, "contact");
                    if let Some(root) = str_field(&value, "skills_root") {
                        match crate::paths::RelPath::new(&root) {
                            Ok(r) => skills_root = r.to_string(),
                            Err(e) => index
                                .diagnostics
                                .push(Diagnostic::error(e.to_string(), Some(manifest_path))),
                        }
                    }
                    manifest_instructions = value
                        .get("instructions")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                }
                Err(errors) => {
                    for e in errors {
                        index
                            .diagnostics
                            .push(Diagnostic::error(e, Some(manifest_path)));
                    }
                }
            },
            Err(e) => index.diagnostics.push(Diagnostic::error(
                format!("could not read the library manifest: {e}"),
                Some(manifest_path),
            )),
        }
    }

    // Skill directories.
    let skill_suffix = format!("/{SKILL_FILE}");
    let root_prefix = format!("{skills_root}/");
    let mut skill_dirs: Vec<String> = files
        .iter()
        .filter(|f| f.path == SKILL_FILE || f.path.ends_with(&skill_suffix))
        .map(|f| dir_of(&f.path).to_string())
        .filter(|d| skills_root.is_empty() || d == &skills_root || d.starts_with(&root_prefix))
        .collect();
    skill_dirs.sort();
    let all_skill_dirs: HashSet<String> = skill_dirs.iter().cloned().collect();
    // A folder sorts before everything inside it, so when a folder is reached
    // the skill enclosing it, if any, has already been accepted. Looking up
    // each of its parent folders keeps this linear in the number of skills
    // (times their depth) for libraries with thousands of them.
    let mut accepted: Vec<String> = Vec::new();
    let mut accepted_dirs: HashSet<&str> = HashSet::new();
    fn parent(dir: &str) -> Option<&str> {
        dir.rsplit_once('/').map(|(p, _)| p)
    }
    for dir in &skill_dirs {
        let enclosing = if !dir.is_empty() && accepted_dirs.contains("") {
            Some("")
        } else {
            std::iter::successors(parent(dir), |d| parent(d)).find(|d| accepted_dirs.contains(d))
        };
        if let Some(outer) = enclosing {
            index.diagnostics.push(Diagnostic::warning(
                format!(
                    "`{dir}` is nested inside the skill `{outer}` and is treated as part of it"
                ),
                Some(&join(dir, SKILL_FILE)),
            ));
            continue;
        }
        accepted_dirs.insert(dir);
        accepted.push(dir.clone());
    }

    let mut seen_ids: HashMap<String, String> = HashMap::new();
    for dir in &accepted {
        let skill_md = join(dir, SKILL_FILE);
        let mut diags = Vec::new();
        let dir_name = if dir.is_empty() {
            "skill".to_string()
        } else {
            dir.rsplit('/').next().unwrap_or(dir).to_string()
        };

        let (front, body_len) = match read_text(&skill_md) {
            Ok(text) => match parse_frontmatter(&text) {
                Ok((fm, body)) => (fm, body.len()),
                Err(e) => {
                    diags.push(Diagnostic::error(e, Some(&skill_md)));
                    (Frontmatter::default(), 0)
                }
            },
            Err(e) => {
                diags.push(Diagnostic::error(e, Some(&skill_md)));
                (Frontmatter::default(), 0)
            }
        };
        let name = match &front.name {
            Some(n) => {
                if let Err(e) = check_skill_name(n) {
                    diags.push(
                        Diagnostic::error(format!("`name` {e}"), Some(&skill_md))
                            .with_code(DiagnosticCode::InvalidName),
                    );
                }
                if n != &dir_name {
                    diags.push(Diagnostic::warning(
                        format!(
                            "`name` ({n}) differs from the directory name ({dir_name}); the Agent Skills specification and Cursor require them to match"
                        ),
                        Some(&skill_md),
                    ));
                }
                n.clone()
            }
            None => {
                diags.push(
                    Diagnostic::error("SKILL.md has no `name`", Some(&skill_md))
                        .with_code(DiagnosticCode::InvalidName),
                );
                dir_name.clone()
            }
        };
        let description = match &front.description {
            Some(d) if !d.is_empty() => {
                if d.chars().count() > 1024 {
                    diags.push(
                        Diagnostic::warning(
                            "`description` is longer than 1024 characters",
                            Some(&skill_md),
                        )
                        .with_code(DiagnosticCode::DescriptionTooLong),
                    );
                }
                d.clone()
            }
            _ => {
                diags.push(
                    Diagnostic::error("SKILL.md has no `description`", Some(&skill_md))
                        .with_code(DiagnosticCode::MissingDescription),
                );
                String::new()
            }
        };
        if body_len > 40_000 {
            diags.push(Diagnostic::info(
                "SKILL.md body is long; the specification recommends under ~5000 tokens",
                Some(&skill_md),
            ));
        }

        // Sidecar metadata.
        let sidecar = SIDECAR_FILES
            .iter()
            .map(|s| join(dir, s))
            .find(|p| by_path.contains_key(p.as_str()));
        let (metadata, status) = match &sidecar {
            None => (Metadata::default(), MetadataStatus::Undeclared),
            Some(path) => match read_text(path).and_then(|t| parse_yaml(&t)) {
                Ok(value) => match schema::validate_skill(&value) {
                    Ok(()) => {
                        let before = diags.len();
                        let md = read_metadata(&value, path, &mut diags);
                        let has_errors = diags
                            .get(before..)
                            .unwrap_or_default()
                            .iter()
                            .any(|d| d.level == DiagnosticLevel::Error);
                        if has_errors {
                            (Metadata::default(), MetadataStatus::Invalid)
                        } else {
                            (md, MetadataStatus::Declared)
                        }
                    }
                    Err(errors) => {
                        for e in errors {
                            diags.push(Diagnostic::error(e, Some(path)));
                        }
                        (Metadata::default(), MetadataStatus::Invalid)
                    }
                },
                Err(e) => {
                    diags.push(Diagnostic::error(
                        format!("habi.yaml could not be read: {e}"),
                        Some(path),
                    ));
                    (Metadata::default(), MetadataStatus::Invalid)
                }
            },
        };

        // Files belonging to this skill (excluding nested skills' own files
        // is unnecessary: nested skills were merged into the outer one).
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        let mut item_files: Vec<ItemFile> = files
            .iter()
            .filter(|f| dir.is_empty() || f.path.starts_with(&prefix))
            .filter(|f| {
                // A root-level skill must not swallow other skills or the manifest.
                !dir.is_empty()
                    || (!MANIFEST_FILES.contains(&f.path.as_str())
                        && !all_skill_dirs
                            .iter()
                            .any(|d| !d.is_empty() && f.path.starts_with(&format!("{d}/"))))
            })
            .map(|f| ItemFile {
                path: f.path.strip_prefix(&prefix).unwrap_or(&f.path).to_string(),
                digest: f.digest.clone(),
                size: f.size,
                executable: f.executable,
            })
            .collect();
        item_files.sort_by(|a, b| a.path.cmp(&b.path));

        // References in workflow steps must exist.
        if let Some(wf) = &metadata.workflow {
            for step in &wf.steps {
                for r in &step.references {
                    if crate::paths::RelPath::new(r).is_err()
                        || !item_files.iter().any(|f| &f.path == r)
                    {
                        diags.push(Diagnostic::warning(
                            format!(
                                "workflow step `{}` references `{r}`, which is not in the skill",
                                step.title
                            ),
                            sidecar.as_deref(),
                        ));
                    }
                }
            }
        }

        let id = metadata.id.clone().unwrap_or_else(|| name.clone());
        let id = if let Some(other) = seen_ids.get(&id) {
            diags.push(Diagnostic::warning(
                format!(
                    "id `{id}` is also used by `{other}`; this item is keyed by its path instead"
                ),
                Some(&skill_md),
            ));
            dir.replace('/', ".")
        } else {
            id
        };
        seen_ids.insert(id.clone(), dir.clone());
        let content_digest = item_digest(&item_files);
        diags.extend(package_checks(dir, &content_digest, &item_files, read));
        let signals = signals::scan(dir, &content_digest, &item_files, read);
        let kind = metadata.kind.unwrap_or(if metadata.workflow.is_some() {
            ItemKind::Workflow
        } else {
            ItemKind::Skill
        });
        index.items.push(LibraryItem {
            key: format!("{source_id}/{id}"),
            source_id: source_id.to_string(),
            id,
            kind,
            title: metadata.title.clone().unwrap_or_else(|| humanize(&name)),
            name,
            description,
            path: dir.clone(),
            owner: metadata.owner,
            based_on: provenance::read(&front.raw),
            license_file: nearest_license(dir, &license_files),
            license_restricted: front.license.as_deref().is_some_and(is_restricted_license),
            license: front.license,
            compatibility: front.compatibility,
            requirement: metadata.requirement,
            priority: metadata.priority,
            scope: metadata.scope,
            applies_when: metadata.applies_when,
            excludes: metadata.excludes,
            tools: metadata.tools,
            mcp: metadata.mcp,
            clients: metadata.clients,
            workflow: metadata.workflow,
            bindings: metadata.bindings,
            checks: metadata.checks,
            evidence: metadata.evidence,
            examples: metadata.examples,
            files: item_files,
            content_digest,
            metadata_status: status,
            diagnostics: diags,
            signals,
            complete: true,
        });
    }

    // Instructions declared in the manifest.
    for entry in manifest_instructions {
        let mut diags = Vec::new();
        let path = str_field(&entry, "path").unwrap_or_default();
        let manifest_path = MANIFEST_FILES[0];
        let Some(file) = by_path.get(path.as_str()) else {
            index.diagnostics.push(Diagnostic::error(
                format!("instructions file `{path}` does not exist"),
                Some(manifest_path),
            ));
            continue;
        };
        let md = read_metadata(&entry, manifest_path, &mut diags);
        // Like a skill's habi.yaml: metadata with errors (an invalid
        // condition, say) is ignored as a whole rather than half-applied. A
        // dropped `excludes` would otherwise turn into a false "applies".
        let invalid = diags.iter().any(|d| d.level == DiagnosticLevel::Error);
        let (md, metadata_status) = if invalid {
            (
                Metadata {
                    id: md.id,
                    title: md.title,
                    ..Metadata::default()
                },
                MetadataStatus::Invalid,
            )
        } else {
            (md, MetadataStatus::Declared)
        };
        let id = md.id.clone().unwrap_or_else(|| path.clone());
        if seen_ids.contains_key(&id) {
            index.diagnostics.push(Diagnostic::error(
                format!("instructions id `{id}` is already used"),
                Some(manifest_path),
            ));
            continue;
        }
        seen_ids.insert(id.clone(), path.clone());
        let file_name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let item_files = vec![ItemFile {
            path: file_name.clone(),
            digest: file.digest.clone(),
            size: file.size,
            executable: file.executable,
        }];
        let content_digest = item_digest(&item_files);
        let license_file = nearest_license(dir_of(&path), &license_files);
        index.items.push(LibraryItem {
            key: format!("{source_id}/{id}"),
            source_id: source_id.to_string(),
            id: id.clone(),
            kind: ItemKind::Instructions,
            title: md.title.clone().unwrap_or_else(|| humanize(&id)),
            name: id.clone(),
            description: str_field(&entry, "description").unwrap_or_default(),
            path,
            owner: md.owner,
            license: None,
            license_file,
            license_restricted: false,
            based_on: None,
            compatibility: None,
            requirement: md.requirement,
            priority: md.priority,
            scope: md.scope,
            applies_when: md.applies_when,
            excludes: md.excludes,
            tools: Vec::new(),
            mcp: Vec::new(),
            clients: None,
            workflow: None,
            bindings: Vec::new(),
            checks: Vec::new(),
            evidence: Vec::new(),
            examples: Vec::new(),
            files: item_files,
            content_digest,
            metadata_status,
            diagnostics: diags,
            signals: Vec::new(),
            complete: true,
        });
    }

    // Name collisions matter at install time (same directory name).
    let mut by_name: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for item in &index.items {
        if item.kind != ItemKind::Instructions {
            by_name.entry(&item.name).or_default().push(&item.path);
        }
    }
    let collisions: Vec<String> = by_name
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(name, paths)| format!("`{name}` ({})", paths.join(", ")))
        .collect();
    for c in collisions {
        index.diagnostics.push(Diagnostic::warning(
            format!("several skills share the name {c}; they would install to the same directory"),
            None,
        ));
    }
    index.items.sort_by_key(|a| a.title.to_lowercase());
    index
}

/// Digest of an item's files: paths, contents and executable bits.
pub fn item_digest(files: &[ItemFile]) -> String {
    let keyed: Vec<(String, String)> = files
        .iter()
        .map(|f| {
            (
                f.path.clone(),
                if f.executable {
                    format!("{}+x", f.digest)
                } else {
                    f.digest.clone()
                },
            )
        })
        .collect();
    tree_digest(keyed.iter().map(|(p, d)| (p.as_str(), d.as_str())))
}

// ----- package checks ----------------------------------------------------------
//
// Static checks of a skill's own files, run wherever a package is indexed
// (libraries, My skills, contributions, `habi validate`). They read files as
// data only: Markdown is scanned for links, JSON and YAML are parsed. Nothing
// is executed, and scripts are not checked at all. Passing these checks says
// nothing about whether a skill is safe or correct.

/// Markdown files read per skill for link checks.
const MAX_MARKDOWN_FILES: usize = 64;
/// JSON and YAML files parsed per skill.
const MAX_DATA_FILES: usize = 64;
/// Larger files are not scanned (reported as not checked).
const MAX_CHECKED_BYTES: u64 = 512 * 1024;
/// Missing-reference problems reported per skill before summarizing.
const MAX_REFERENCE_PROBLEMS: usize = 20;

/// Results by item content digest. A library is re-indexed often (every
/// overview), and its content only changes on refresh, so each package is
/// read and parsed once per process.
fn check_memo() -> &'static std::sync::Mutex<HashMap<String, Vec<Diagnostic>>> {
    static MEMO: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Vec<Diagnostic>>>> =
        std::sync::OnceLock::new();
    MEMO.get_or_init(Default::default)
}

/// Diagnostics for a skill's files, with library-relative paths.
fn package_checks(
    dir: &str,
    content_digest: &str,
    files: &[ItemFile],
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Vec<Diagnostic> {
    let cached = check_memo()
        .lock()
        .ok()
        .and_then(|m| m.get(content_digest).cloned());
    let relative = match cached {
        Some(d) => d,
        None => {
            let (diags, complete) = check_package_files(files, &|rel| read(&join(dir, rel)));
            if complete && let Ok(mut memo) = check_memo().lock() {
                if memo.len() > 8_192 {
                    memo.clear();
                }
                memo.insert(content_digest.to_string(), diags.clone());
            }
            diags
        }
    };
    relative
        .into_iter()
        .map(|d| Diagnostic {
            path: d.path.map(|p| join(dir, &p)),
            ..d
        })
        .collect()
}

/// 1-based line of the first occurrence of `needle` in `text`.
fn line_of(text: &str, needle: &str) -> Option<u32> {
    let at = text.find(needle)?;
    u32::try_from(text.get(..at)?.matches('\n').count() + 1).ok()
}

/// Checks a package's files (package-relative paths). Returns the
/// diagnostics and whether every file could be read.
pub(crate) fn check_package_files(
    files: &[ItemFile],
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> (Vec<Diagnostic>, bool) {
    let mut diags = Vec::new();
    let mut complete = true;
    let paths: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let lower_ext = |p: &str| {
        p.rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default()
    };
    let mut text_of = |f: &ItemFile, what: &str, diags: &mut Vec<Diagnostic>| -> Option<String> {
        if f.size > MAX_CHECKED_BYTES {
            diags.push(Diagnostic::info(
                format!(
                    "{} was not checked as {what}: it is larger than {} KiB",
                    f.path,
                    MAX_CHECKED_BYTES / 1024
                ),
                Some(&f.path),
            ));
            return None;
        }
        match read(&f.path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(t) => Some(t.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(t)),
                Err(_) => {
                    diags.push(
                        Diagnostic::warning(
                            format!("{} is not UTF-8 text, so it is not valid {what}", f.path),
                            Some(&f.path),
                        )
                        .with_code(DiagnosticCode::UnreadableFile),
                    );
                    None
                }
            },
            Err(_) => {
                complete = false;
                None
            }
        }
    };

    // Local file references in Markdown.
    let mut problems: Vec<Diagnostic> = Vec::new();
    for f in files
        .iter()
        // Assets are often templates whose links are placeholders.
        .filter(|f| lower_ext(&f.path) == "md" && !f.path.starts_with("assets/"))
        .take(MAX_MARKDOWN_FILES)
    {
        let Some(text) = text_of(f, "Markdown", &mut diags) else {
            continue;
        };
        // Lines in SKILL.md count in the instructions as an editor shows
        // them: after the frontmatter and the blank lines that follow it.
        let body = if f.path == SKILL_FILE {
            split_frontmatter(&text)
                .map(|(_, b)| b.trim_start_matches(['\n', '\r']))
                .unwrap_or(&text)
        } else {
            &text
        };
        let from_dir = dir_of(&f.path);
        let mut seen: HashSet<String> = HashSet::new();
        for reference in markdown_references(body) {
            let (problem, raw) = match &reference {
                MarkdownRef::Link(raw) => (
                    match resolve_link(from_dir, raw) {
                        None => None,
                        Some(Err(())) => Some((
                            format!(
                                "{} links to `{raw}`, which points outside the skill; it will not resolve once the skill is installed or shared on its own",
                                f.path
                            ),
                            DiagnosticCode::BrokenLink,
                        )),
                        Some(Ok(target)) if !package_has(&paths, &target) => Some((
                            format!("{} links to `{target}`, which is not in the skill", f.path),
                            DiagnosticCode::MissingReferencedFile,
                        )),
                        Some(Ok(_)) => None,
                    },
                    raw,
                ),
                MarkdownRef::Code(raw) => (
                    match code_path(raw) {
                        Some(target)
                            if !package_has(&paths, &target)
                                && !resolve_link(from_dir, &target)
                                    .and_then(Result::ok)
                                    .is_some_and(|t| package_has(&paths, &t)) =>
                        {
                            Some((
                                format!(
                                    "{} mentions `{target}`, which is not in the skill",
                                    f.path
                                ),
                                DiagnosticCode::MissingReferencedFile,
                            ))
                        }
                        _ => None,
                    },
                    raw,
                ),
            };
            if let Some((message, code)) = problem
                && seen.insert(message.clone())
            {
                problems.push(
                    Diagnostic::warning(message, Some(&f.path))
                        .with_code(code)
                        .at_line(line_of(body, raw)),
                );
            }
        }
    }
    if problems.len() > MAX_REFERENCE_PROBLEMS {
        let more = problems.len() - MAX_REFERENCE_PROBLEMS;
        problems.truncate(MAX_REFERENCE_PROBLEMS);
        problems.push(Diagnostic::warning(
            format!("{more} more references to files that are not in the skill"),
            None,
        ));
    }
    diags.extend(problems);

    // JSON and YAML must at least parse. habi.yaml is validated on its own.
    for f in files
        .iter()
        .filter(|f| {
            matches!(lower_ext(&f.path).as_str(), "json" | "yaml" | "yml")
                && !SIDECAR_FILES.contains(&f.path.as_str())
        })
        .take(MAX_DATA_FILES)
    {
        let json = lower_ext(&f.path) == "json";
        let what = if json { "JSON" } else { "YAML" };
        let Some(text) = text_of(f, what, &mut diags) else {
            continue;
        };
        if !json && text.len() > METADATA_LIMIT {
            diags.push(Diagnostic::info(
                format!(
                    "{} was not checked as YAML: it is larger than {} KiB",
                    f.path,
                    METADATA_LIMIT / 1024
                ),
                Some(&f.path),
            ));
            continue;
        }
        let problem = if json {
            check_json(&text).err()
        } else {
            check_yaml(&text).err()
        };
        if let Some(e) = problem {
            diags.push(
                Diagnostic::warning(
                    format!("{} is not valid {what}: {e}", f.path),
                    Some(&f.path),
                )
                .with_code(if json {
                    DiagnosticCode::InvalidJson
                } else {
                    DiagnosticCode::InvalidYaml
                }),
            );
        }
    }
    (diags, complete)
}

fn package_has(paths: &HashSet<&str>, target: &str) -> bool {
    let target = target.trim_end_matches('/');
    target.is_empty()
        || paths.contains(target)
        || paths.iter().any(|p| {
            p.strip_prefix(target)
                .is_some_and(|rest| rest.starts_with('/'))
        })
}

fn check_json(text: &str) -> Result<(), String> {
    match serde_json::from_str::<serde::de::IgnoredAny>(text) {
        Ok(_) => Ok(()),
        // Many tools read JSON with comments and trailing commas
        // (tsconfig.json, editor settings); those are not reported.
        Err(e) => match serde_json::from_str::<serde::de::IgnoredAny>(&strip_jsonc(text)) {
            Ok(_) => Ok(()),
            Err(_) => Err(e.to_string()),
        },
    }
}

/// Removes `//` and `/* */` comments and trailing commas outside strings.
#[allow(
    clippy::indexing_slicing,
    reason = "a scanner: every index is checked against the length first"
)]
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn check_yaml(text: &str) -> Result<(), String> {
    serde_saphyr::from_multiple_with_options::<Value>(text, yaml_options())
        .map(|_| ())
        .map_err(|e| {
            // Keep the first line: the full message may echo content.
            e.to_string()
                .lines()
                .next()
                .unwrap_or("invalid YAML")
                .to_string()
        })
}

#[derive(Debug, PartialEq, Eq)]
enum MarkdownRef {
    /// A link or image destination, as written.
    Link(String),
    /// The text of an inline code span.
    Code(String),
}

/// Link destinations and inline code spans in Markdown, outside fenced code
/// blocks and HTML comments. Deliberately simple: anything it is unsure
/// about is left out rather than reported.
#[allow(
    clippy::string_slice,
    reason = "bounds come from find() of ASCII delimiters in the same string"
)]
fn markdown_references(text: &str) -> Vec<MarkdownRef> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    for line in text.lines() {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if indent <= 3
            && let Some(ch) = fence_char
        {
            let run = trimmed.chars().take_while(|c| *c == ch).count();
            if run >= 3 {
                match fence {
                    None => {
                        fence = Some((ch, run));
                        continue;
                    }
                    Some((open, len))
                        if open == ch && run >= len && trimmed[run..].trim().is_empty() =>
                    {
                        fence = None;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        if fence.is_some() {
            continue;
        }
        // Drop HTML comments, which may span lines.
        let mut visible = String::new();
        let mut rest = line;
        loop {
            if in_comment {
                match rest.find("-->") {
                    Some(end) => {
                        rest = &rest[end + 3..];
                        in_comment = false;
                    }
                    None => break,
                }
            } else {
                match rest.find("<!--") {
                    Some(start) => {
                        visible.push_str(&rest[..start]);
                        rest = &rest[start + 4..];
                        in_comment = true;
                    }
                    None => {
                        visible.push_str(rest);
                        break;
                    }
                }
            }
        }
        // Reference definitions: `[label]: destination`.
        let def = visible.trim_start_matches(' ');
        if visible.len() - def.len() <= 3
            && def.starts_with('[')
            && !def.starts_with("[^")
            && let Some(close) = def.find("]:")
        {
            if let Some(dest) = def[close + 2..].split_whitespace().next() {
                let dest = dest
                    .strip_prefix('<')
                    .and_then(|d| d.strip_suffix('>'))
                    .unwrap_or(dest);
                out.push(MarkdownRef::Link(dest.to_string()));
            }
            continue;
        }
        inline_references(&visible, &mut out);
    }
    out
}

#[allow(
    clippy::indexing_slicing,
    reason = "a scanner: every index is checked against the length first"
)]
fn inline_references(line: &str, out: &mut Vec<MarkdownRef>) {
    let chars: Vec<char> = line.chars().collect();
    // Where each whole run of backticks starts, by its length, with how many
    // of those starts are already behind the scanner. A code span closes at
    // the next run of exactly its opener's length; looking that up here,
    // instead of scanning the rest of the line for every opener, keeps a line
    // of many unmatched runs (hostile, or just odd) linear.
    let mut runs: HashMap<usize, (Vec<usize>, usize)> = HashMap::new();
    let mut k = 0;
    while k < chars.len() {
        if chars[k] == '`' {
            let r = chars[k..].iter().take_while(|c| **c == '`').count();
            runs.entry(r).or_default().0.push(k);
            k += r;
        } else {
            k += 1;
        }
    }
    let mut i = 0;
    let mut open_brackets = 0usize;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '`' => {
                let run = chars[i..].iter().take_while(|c| **c == '`').count();
                // The first run of exactly the same length after this one.
                // The scanner only moves forward, so neither does `passed`.
                let close = runs.get_mut(&run).and_then(|(starts, passed)| {
                    while starts.get(*passed).is_some_and(|&s| s < i + run) {
                        *passed += 1;
                    }
                    starts.get(*passed).copied()
                });
                match close {
                    Some(end) => {
                        let code: String = chars[i + run..end].iter().collect();
                        out.push(MarkdownRef::Code(code.trim().to_string()));
                        i = end + run;
                        continue;
                    }
                    None => i += run - 1,
                }
            }
            '[' => open_brackets += 1,
            ']' if open_brackets > 0 => {
                open_brackets -= 1;
                if chars.get(i + 1) == Some(&'(') {
                    let mut j = i + 2;
                    while j < chars.len() && chars[j] == ' ' {
                        j += 1;
                    }
                    let mut dest = String::new();
                    if chars.get(j) == Some(&'<') {
                        j += 1;
                        while j < chars.len() && chars[j] != '>' {
                            dest.push(chars[j]);
                            j += 1;
                        }
                    } else {
                        let mut depth = 0usize;
                        while j < chars.len() && !chars[j].is_whitespace() {
                            match chars[j] {
                                '(' => depth += 1,
                                ')' if depth == 0 => break,
                                ')' => depth -= 1,
                                _ => {}
                            }
                            dest.push(chars[j]);
                            j += 1;
                        }
                    }
                    out.push(MarkdownRef::Link(dest));
                    i = j;
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }
}

/// Resolves a link destination against the folder of the file it is in.
/// `None`: not a reference to a package file (URL, anchor, absolute path,
/// template). `Some(Err)`: it climbs out of the package.
fn resolve_link(from_dir: &str, raw: &str) -> Option<Result<String, ()>> {
    let raw = raw.trim();
    let is_url = raw.split_once(':').is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if raw.is_empty()
        || is_url
        || raw.starts_with(['#', '/', '\\', '~'])
        || raw.contains(['{', '}', '*', '$', '<', '>', '|', '\\', '"', '\''])
    {
        return None;
    }
    let path = raw.split(['#', '?']).next().unwrap_or_default();
    if path.is_empty() {
        return None;
    }
    let path = percent_decode(path)?;
    let mut parts: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Some(Err(()));
                }
            }
            s => parts.push(s),
        }
    }
    Some(Ok(parts.join("/")))
}

#[allow(
    clippy::indexing_slicing,
    reason = "a scanner: every index is checked against the length first"
)]
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// An inline code span that is plainly a path into the package's standard
/// folders, such as `scripts/check.py`.
fn code_path(code: &str) -> Option<String> {
    let (folder, rest) = code.split_once('/')?;
    let plain = !rest.is_empty()
        && !code.chars().any(char::is_whitespace)
        && !code.contains([
            '*', '?', '{', '}', '<', '>', '[', ']', '(', ')', '$', '|', '\\', ':', ',', '=', '#',
            '@',
        ])
        && !code.split('/').any(|s| s == "..");
    (matches!(folder, "scripts" | "references" | "assets") && plain).then(|| code.to_string())
}

/// Words that are read as letters, kept upper-case in a humanized title.
const INITIALISMS: &[&str] = &[
    "ai", "api", "apis", "aws", "ci", "cli", "css", "csv", "docx", "gcp", "gif", "html", "http",
    "id", "jpa", "json", "jvm", "llm", "mcp", "orm", "pdf", "pptx", "pr", "sdk", "sql", "tdd",
    "ui", "url", "ux", "xlsx", "xml", "yaml",
];

/// `liquibase-migration-review` -> `Liquibase migration review`;
/// `claude-api` -> `Claude API`.
pub fn humanize(name: &str) -> String {
    let words: Vec<String> = name
        .split(['-', '_', '.', ' '])
        .filter(|w| !w.is_empty())
        .enumerate()
        .map(|(i, w)| {
            if INITIALISMS.contains(&w.to_ascii_lowercase().as_str()) {
                w.to_ascii_uppercase()
            } else if i == 0 {
                let mut chars = w.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            } else {
                w.to_string()
            }
        })
        .collect();
    words.join(" ")
}

#[cfg(test)]
mod tests;
