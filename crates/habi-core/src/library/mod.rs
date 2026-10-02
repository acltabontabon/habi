//! Turning a library snapshot (a set of files) into an index of items.
//!
//! A skill is any directory containing `SKILL.md` (Agent Skills format). An
//! optional `habi.yaml` next to it adds Habi metadata. The library may have
//! a `habi-library.yaml` manifest describing the library and declaring
//! portable instructions. Content is never executed or rewritten here.

pub mod model;
pub mod schema;

use crate::clients::ClientId;
use crate::fsutil::tree_digest;
use crate::matching::Scope;
use crate::matching::condition::Condition;
use model::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SKILL_FILE: &str = "SKILL.md";
pub const SIDECAR_FILES: &[&str] = &["habi.yaml", "habi.yml"];
pub const MANIFEST_FILES: &[&str] = &["habi-library.yaml", "habi-library.yml"];
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
    let mut skill_dirs: Vec<String> = files
        .iter()
        .filter(|f| f.path == SKILL_FILE || f.path.ends_with(&format!("/{SKILL_FILE}")))
        .map(|f| dir_of(&f.path).to_string())
        .filter(|d| {
            skills_root.is_empty() || d == &skills_root || d.starts_with(&format!("{skills_root}/"))
        })
        .collect();
    skill_dirs.sort();
    let all_skill_dirs: HashSet<String> = skill_dirs.iter().cloned().collect();
    let mut accepted: Vec<String> = Vec::new();
    for dir in &skill_dirs {
        if let Some(outer) = accepted
            .iter()
            .find(|o| o.is_empty() || dir.starts_with(&format!("{o}/")))
        {
            index.diagnostics.push(Diagnostic::warning(
                format!(
                    "`{dir}` is nested inside the skill `{outer}` and is treated as part of it"
                ),
                Some(&join(dir, SKILL_FILE)),
            ));
            continue;
        }
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
                    diags.push(Diagnostic::error(format!("`name` {e}"), Some(&skill_md)));
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
                diags.push(Diagnostic::error("SKILL.md has no `name`", Some(&skill_md)));
                dir_name.clone()
            }
        };
        let description = match &front.description {
            Some(d) if !d.is_empty() => {
                if d.chars().count() > 1024 {
                    diags.push(Diagnostic::warning(
                        "`description` is longer than 1024 characters",
                        Some(&skill_md),
                    ));
                }
                d.clone()
            }
            _ => {
                diags.push(Diagnostic::error(
                    "SKILL.md has no `description`",
                    Some(&skill_md),
                ));
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
                        let has_errors = diags[before..]
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
                path: f.path[prefix.len()..].to_string(),
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

/// `liquibase-migration-review` -> `Liquibase migration review`.
pub fn humanize(name: &str) -> String {
    let spaced = name.replace(['-', '_', '.'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests;
