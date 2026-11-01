//! Applicability conditions: a small declarative language with `all`, `any`,
//! `not` and four predicates (dependency, file, tag, code). No scripting, no
//! regular expressions from content, bounded size. `code` looks a name up among
//! the imports and annotations inspection already found; it searches nothing.

use crate::inspect::model::{CodeKind, CodeLanguage, Ecosystem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const MAX_DEPTH: usize = 8;
pub const MAX_NODES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EcosystemFilter {
    Maven,
    Gradle,
    Npm,
    Go,
    Cargo,
    Pypi,
    Composer,
    /// Maven or Gradle.
    Jvm,
}

impl EcosystemFilter {
    pub fn accepts(self, e: Ecosystem) -> bool {
        match self {
            EcosystemFilter::Maven => e == Ecosystem::Maven,
            EcosystemFilter::Gradle => e == Ecosystem::Gradle,
            EcosystemFilter::Npm => e == Ecosystem::Npm,
            EcosystemFilter::Go => e == Ecosystem::Go,
            EcosystemFilter::Cargo => e == Ecosystem::Cargo,
            EcosystemFilter::Pypi => e == Ecosystem::Pypi,
            EcosystemFilter::Composer => e == Ecosystem::Composer,
            EcosystemFilter::Jvm => e.is_jvm(),
        }
    }

    pub fn ecosystems(self) -> &'static [Ecosystem] {
        match self {
            EcosystemFilter::Maven => &[Ecosystem::Maven],
            EcosystemFilter::Gradle => &[Ecosystem::Gradle],
            EcosystemFilter::Npm => &[Ecosystem::Npm],
            EcosystemFilter::Go => &[Ecosystem::Go],
            EcosystemFilter::Cargo => &[Ecosystem::Cargo],
            EcosystemFilter::Pypi => &[Ecosystem::Pypi],
            EcosystemFilter::Composer => &[Ecosystem::Composer],
            EcosystemFilter::Jvm => &[Ecosystem::Maven, Ecosystem::Gradle],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "op")]
#[ts(export)]
pub enum Condition {
    All {
        items: Vec<Condition>,
    },
    Any {
        items: Vec<Condition>,
    },
    Not {
        item: Box<Condition>,
    },
    #[serde(rename_all = "camelCase")]
    Dependency {
        name: String,
        ecosystem: Option<EcosystemFilter>,
        version: Option<String>,
    },
    File {
        glob: String,
    },
    Tag {
        tag: String,
    },
    /// An import or annotation in the project's source.
    Code {
        kind: CodeKind,
        name: String,
        language: Option<CodeLanguage>,
    },
}

impl Condition {
    /// Parses the authoring form (`{all: [...]}`, `{dependency: "g:a"}`,
    /// `{file: "glob"}`, `{tag: "x"}`, `{code: {import: "x"}}`), enforcing
    /// size and depth limits.
    /// Schema validation runs first; these checks guard the engine itself.
    pub fn parse(value: &Value) -> Result<Condition, String> {
        let mut nodes = 0;
        parse_node(value, 0, &mut nodes)
    }

    /// Ecosystem-agnostic view of a dependency name: JVM coordinates contain `:`.
    pub fn describe(&self) -> String {
        match self {
            Condition::All { items } => format!("all of {} conditions", items.len()),
            Condition::Any { items } => format!("any of {} conditions", items.len()),
            Condition::Not { item } => format!("not ({})", item.describe()),
            Condition::Dependency {
                name,
                ecosystem,
                version,
            } => {
                let mut s = format!("declares {name}");
                if let Some(v) = version {
                    s.push_str(&format!(" {v}"));
                }
                match ecosystem {
                    Some(EcosystemFilter::Maven) => s.push_str(" (Maven)"),
                    Some(EcosystemFilter::Gradle) => s.push_str(" (Gradle)"),
                    Some(EcosystemFilter::Npm) => s.push_str(" (npm)"),
                    Some(EcosystemFilter::Go) => s.push_str(" (Go)"),
                    Some(EcosystemFilter::Cargo) => s.push_str(" (Cargo)"),
                    Some(EcosystemFilter::Pypi) => s.push_str(" (PyPI)"),
                    Some(EcosystemFilter::Composer) => s.push_str(" (Composer)"),
                    Some(EcosystemFilter::Jvm) | None => {}
                }
                s
            }
            // A file by name, anywhere ("**/manage.py"), reads as that name.
            Condition::File { glob } => match glob.strip_prefix("**/").unwrap_or(glob) {
                name if !name.contains(['*', '?', '[', '{', '/']) => format!("has {name}"),
                _ => format!("has files matching {glob}"),
            },
            Condition::Tag { tag } => crate::inspect::tags::phrase(tag),
            Condition::Code {
                kind,
                name,
                language,
            } => {
                let mut s = match kind {
                    CodeKind::Import => format!("imports {name}"),
                    CodeKind::Annotation => format!("uses the annotation {name}"),
                };
                if let Some(l) = language {
                    s.push_str(&format!(" ({})", l.label()));
                }
                s
            }
        }
    }
}

fn single_key(value: &Value) -> Result<(&str, &Value), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "a condition must be a mapping such as `tag: lang:java`".to_string())?;
    if obj.len() != 1 {
        return Err(format!(
            "a condition must have exactly one key (all, any, not, dependency, file, tag or code); found {}",
            obj.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    let (k, v) = obj.iter().next().expect("one entry");
    Ok((k.as_str(), v))
}

fn parse_node(value: &Value, depth: usize, nodes: &mut usize) -> Result<Condition, String> {
    *nodes += 1;
    if *nodes > MAX_NODES {
        return Err(format!("conditions may contain at most {MAX_NODES} parts"));
    }
    if depth > MAX_DEPTH {
        return Err(format!(
            "conditions may be nested at most {MAX_DEPTH} levels"
        ));
    }
    let (key, inner) = single_key(value)?;
    match key {
        "all" | "any" => {
            let list = inner
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| format!("`{key}` needs a non-empty list"))?;
            let items = list
                .iter()
                .map(|v| parse_node(v, depth + 1, nodes))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(if key == "all" {
                Condition::All { items }
            } else {
                Condition::Any { items }
            })
        }
        "not" => Ok(Condition::Not {
            item: Box::new(parse_node(inner, depth + 1, nodes)?),
        }),
        "dependency" => match inner {
            Value::String(name) => Ok(Condition::Dependency {
                name: check_name(name)?,
                ecosystem: None,
                version: None,
            }),
            Value::Object(o) => {
                let name = o
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("`dependency` needs a `name`")?;
                let ecosystem = match o.get("ecosystem").and_then(Value::as_str) {
                    None => None,
                    Some("maven") => Some(EcosystemFilter::Maven),
                    Some("gradle") => Some(EcosystemFilter::Gradle),
                    Some("npm") => Some(EcosystemFilter::Npm),
                    Some("go") => Some(EcosystemFilter::Go),
                    Some("cargo") => Some(EcosystemFilter::Cargo),
                    Some("pypi") => Some(EcosystemFilter::Pypi),
                    Some("composer") => Some(EcosystemFilter::Composer),
                    Some("jvm") => Some(EcosystemFilter::Jvm),
                    Some(other) => return Err(format!("unknown ecosystem `{other}`")),
                };
                let version = match o.get("version").and_then(Value::as_str) {
                    Some(v) => {
                        super::version::parse_requirement(v)?;
                        Some(v.to_string())
                    }
                    None => None,
                };
                Ok(Condition::Dependency {
                    name: check_name(name)?,
                    ecosystem,
                    version,
                })
            }
            _ => Err("`dependency` must be a name or a mapping".into()),
        },
        "file" => {
            let glob = inner.as_str().ok_or("`file` must be a glob pattern")?;
            if glob.len() > 256 || glob.contains("..") || glob.starts_with('/') {
                return Err(format!("invalid file pattern `{glob}`"));
            }
            globset::GlobBuilder::new(glob)
                .literal_separator(true)
                .build()
                .map_err(|e| format!("invalid file pattern `{glob}`: {e}"))?;
            Ok(Condition::File {
                glob: glob.to_string(),
            })
        }
        "tag" => {
            let tag = inner.as_str().ok_or("`tag` must be a string")?;
            Ok(Condition::Tag {
                tag: tag.to_string(),
            })
        }
        "code" => parse_code(inner),
        other => Err(format!(
            "unknown condition `{other}` (expected all, any, not, dependency, file, tag or code)"
        )),
    }
}

fn parse_code(inner: &Value) -> Result<Condition, String> {
    let o = inner
        .as_object()
        .ok_or("`code` must be a mapping such as `import: react`")?;
    if let Some(other) = o
        .keys()
        .find(|k| !matches!(k.as_str(), "import" | "annotation" | "language"))
    {
        return Err(format!(
            "unknown `code` key `{other}` (expected import, annotation or language)"
        ));
    }
    let (kind, name) = match (o.get("import"), o.get("annotation")) {
        (Some(v), None) => (CodeKind::Import, v),
        (None, Some(v)) => (CodeKind::Annotation, v),
        _ => return Err("`code` needs exactly one of `import` or `annotation`".into()),
    };
    let name = name.as_str().ok_or("a `code` name must be a string")?;
    // Written as it reads in source; `@` is not part of an annotation's name.
    let name = match kind {
        CodeKind::Annotation => name.strip_prefix('@').unwrap_or(name),
        CodeKind::Import => name,
    };
    let clean = name
        .chars()
        .all(|c| c.is_alphanumeric() || "._-/@:\\$+~*".contains(c));
    if name.is_empty() || name.len() > 200 || name.matches('*').count() > 3 || !clean {
        return Err(format!("invalid `code` name `{name}`"));
    }
    let language = match o.get("language").and_then(Value::as_str) {
        None => None,
        Some("java") => Some(CodeLanguage::Java),
        Some("kotlin") => Some(CodeLanguage::Kotlin),
        Some("javascript") => Some(CodeLanguage::Javascript),
        Some("typescript") => Some(CodeLanguage::Typescript),
        Some("python") => Some(CodeLanguage::Python),
        Some("go") => Some(CodeLanguage::Go),
        Some("rust") => Some(CodeLanguage::Rust),
        Some("php") => Some(CodeLanguage::Php),
        Some(other) => return Err(format!("Habi does not read `{other}` source")),
    };
    Ok(Condition::Code {
        kind,
        name: name.to_string(),
        language,
    })
}

fn check_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 200 || name.matches('*').count() > 3 {
        return Err(format!("invalid dependency name `{name}`"));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_authoring_form() {
        let c = Condition::parse(&json!({
            "all": [
                {"tag": "framework:spring-boot"},
                {"any": [{"dependency": "org.liquibase:liquibase-core"}, {"file": "**/db/changelog/**"}]},
                {"not": {"dependency": {"name": "org.jooq:*", "ecosystem": "jvm"}}}
            ]
        }))
        .unwrap();
        match c {
            Condition::All { items } => assert_eq!(items.len(), 3),
            _ => panic!("expected all"),
        }
    }

    #[test]
    fn rejects_ambiguous_or_unknown_forms() {
        assert!(Condition::parse(&json!({"tag": "x", "file": "y"})).is_err());
        assert!(Condition::parse(&json!({"script": "rm -rf /"})).is_err());
        assert!(Condition::parse(&json!({"all": []})).is_err());
        assert!(Condition::parse(&json!({"file": "../outside/**"})).is_err());
        assert!(
            Condition::parse(&json!({"dependency": {"name": "x", "version": "not a range!!"}}))
                .is_err()
        );
    }

    #[test]
    fn parses_code_conditions() {
        assert_eq!(
            Condition::parse(&json!({"code": {"import": "org.jooq.*", "language": "java"}})),
            Ok(Condition::Code {
                kind: CodeKind::Import,
                name: "org.jooq.*".into(),
                language: Some(CodeLanguage::Java),
            })
        );
        let annotation = Condition::parse(&json!({"code": {"annotation": "@Transactional"}}));
        assert_eq!(
            annotation,
            Ok(Condition::Code {
                kind: CodeKind::Annotation,
                name: "Transactional".into(),
                language: None,
            })
        );
        assert_eq!(
            annotation.unwrap().describe(),
            "uses the annotation Transactional"
        );
        for bad in [
            json!({"code": "react"}),
            json!({"code": {}}),
            json!({"code": {"language": "java"}}),
            json!({"code": {"import": "a", "annotation": "b"}}),
            json!({"code": {"import": "a", "pattern": "b"}}),
            json!({"code": {"import": ""}}),
            json!({"code": {"import": "a b"}}),
            json!({"code": {"import": "$(whoami)"}}),
            json!({"code": {"import": "a*b*c*d*e"}}),
            json!({"code": {"import": "a", "language": "cobol"}}),
        ] {
            assert!(Condition::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn enforces_depth_and_size_limits() {
        let mut deep = json!({"tag": "x"});
        for _ in 0..12 {
            deep = json!({"not": deep});
        }
        assert!(Condition::parse(&deep).is_err());
        let wide =
            json!({"any": (0..100).map(|i| json!({"tag": format!("t{i}")})).collect::<Vec<_>>()});
        assert!(Condition::parse(&wide).is_err());
    }
}
