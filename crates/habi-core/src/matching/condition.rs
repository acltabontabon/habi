//! Applicability conditions: a small declarative language with `all`, `any`,
//! `not` and four predicates (dependency, file, tag). No scripting, no
//! regular expressions from content, bounded size.

use crate::inspect::model::Ecosystem;
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
    /// Maven or Gradle.
    Jvm,
}

impl EcosystemFilter {
    pub fn accepts(self, e: Ecosystem) -> bool {
        match self {
            EcosystemFilter::Maven => e == Ecosystem::Maven,
            EcosystemFilter::Gradle => e == Ecosystem::Gradle,
            EcosystemFilter::Npm => e == Ecosystem::Npm,
            EcosystemFilter::Jvm => e.is_jvm(),
        }
    }

    pub fn ecosystems(self) -> &'static [Ecosystem] {
        match self {
            EcosystemFilter::Maven => &[Ecosystem::Maven],
            EcosystemFilter::Gradle => &[Ecosystem::Gradle],
            EcosystemFilter::Npm => &[Ecosystem::Npm],
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
}

impl Condition {
    /// Parses the authoring form (`{all: [...]}`, `{dependency: "g:a"}`,
    /// `{file: "glob"}`, `{tag: "x"}`), enforcing size and depth limits.
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
                    Some(EcosystemFilter::Jvm) | None => {}
                }
                s
            }
            Condition::File { glob } => format!("has files matching {glob}"),
            Condition::Tag { tag } => crate::inspect::tags::phrase(tag),
        }
    }
}

fn single_key(value: &Value) -> Result<(&str, &Value), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "a condition must be a mapping such as `tag: lang:java`".to_string())?;
    if obj.len() != 1 {
        return Err(format!(
            "a condition must have exactly one key (all, any, not, dependency, file or tag); found {}",
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
        other => Err(format!(
            "unknown condition `{other}` (expected all, any, not, dependency, file or tag)"
        )),
    }
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
