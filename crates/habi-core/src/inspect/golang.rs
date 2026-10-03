//! Go modules: `go.mod`'s module path and its requirements.
//!
//! Versions in `go.mod` are exact (minimal version selection picks at least
//! these), so every requirement is a resolved version. `replace` and
//! `exclude` directives are not followed; a replaced module is still the
//! module the code imports.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};

const DETECTOR: &str = "go";

#[derive(Debug, Clone)]
pub struct GoMod {
    pub path: String,
    /// The directory of `go.mod`: the module in Habi's sense.
    pub module: String,
    /// The module path, `github.com/acme/app`.
    pub name: Option<String>,
    pub requires: Vec<Require>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Require {
    pub path: String,
    pub version: String,
    /// Marked `// indirect`: needed by a dependency, not imported here.
    pub indirect: bool,
    /// 1-based.
    pub line: u32,
}

/// Reads `go.mod`. Tolerant: a line it does not understand is skipped.
pub fn parse(path: &str, module: &str, text: &str) -> GoMod {
    let mut name = None;
    let mut requires = Vec::new();
    let mut in_require = false;
    for (i, raw) in text.lines().enumerate() {
        let line_no = i as u32 + 1;
        let (code, comment) = match raw.split_once("//") {
            Some((c, rest)) => (c.trim(), rest.trim()),
            None => (raw.trim(), ""),
        };
        let indirect = comment.starts_with("indirect");
        if in_require {
            if code == ")" {
                in_require = false;
            } else if let Some(r) = requirement(code, indirect, line_no) {
                requires.push(r);
            }
            continue;
        }
        let mut words = code.split_whitespace();
        match words.next() {
            Some("module") => name = words.next().map(|w| w.trim_matches('"').to_string()),
            Some("require") => {
                let rest = code.strip_prefix("require").unwrap_or("").trim();
                if rest == "(" {
                    in_require = true;
                } else if let Some(r) = requirement(rest, indirect, line_no) {
                    requires.push(r);
                }
            }
            _ => {}
        }
    }
    GoMod {
        path: path.to_string(),
        module: module.to_string(),
        name,
        requires,
    }
}

fn requirement(code: &str, indirect: bool, line: u32) -> Option<Require> {
    let mut words = code.split_whitespace();
    let path = words.next()?.trim_matches('"');
    let version = words.next()?;
    version.starts_with('v').then(|| Require {
        path: path.to_string(),
        version: version.to_string(),
        indirect,
        line,
    })
}

/// The module's display name: the last segment of its path (`app` for
/// `github.com/acme/app`), skipping a major-version suffix (`/v2`).
pub fn display_name(module_path: &str) -> Option<String> {
    let mut parts = module_path.rsplit('/');
    let last = parts.next()?;
    let is_major = last
        .strip_prefix('v')
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    let name = if is_major { parts.next()? } else { last };
    (!name.is_empty()).then(|| name.to_string())
}

pub fn collect(mods: &[GoMod], out: &mut Collector) {
    for m in mods {
        for r in &m.requires {
            out.dependency(
                &m.module,
                Ecosystem::Go,
                &r.path,
                Some(if r.indirect { "indirect" } else { "require" }.to_string()),
                VersionInfo {
                    state: VersionState::Resolved,
                    declared: Some(r.version.clone()),
                    resolved: Some(r.version.clone()),
                    note: Some("required in go.mod".into()),
                },
                FactOrigin::Direct,
                DETECTOR,
                Evidence {
                    file: m.path.clone(),
                    line: Some(r.line),
                    excerpt: Some(format!("{} {}", r.path, r.version)),
                },
            );
        }
        out.coverage(&m.module, "go", CoverageStatus::Complete, Vec::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GO_MOD: &str = r#"module github.com/acme/encryptor/v2

go 1.22

require github.com/wailsapp/wails/v2 v2.9.1

require (
	github.com/spf13/cobra v1.8.0
	golang.org/x/crypto v0.21.0 // indirect
	// a comment line
)

replace github.com/spf13/cobra => ../cobra
"#;

    #[test]
    fn reads_the_module_and_its_requirements() {
        let m = parse("go.mod", ".", GO_MOD);
        assert_eq!(m.name.as_deref(), Some("github.com/acme/encryptor/v2"));
        assert_eq!(
            m.requires,
            vec![
                Require {
                    path: "github.com/wailsapp/wails/v2".into(),
                    version: "v2.9.1".into(),
                    indirect: false,
                    line: 5,
                },
                Require {
                    path: "github.com/spf13/cobra".into(),
                    version: "v1.8.0".into(),
                    indirect: false,
                    line: 8,
                },
                Require {
                    path: "golang.org/x/crypto".into(),
                    version: "v0.21.0".into(),
                    indirect: true,
                    line: 9,
                },
            ]
        );
        assert_eq!(
            display_name("github.com/acme/encryptor/v2").as_deref(),
            Some("encryptor")
        );
        assert_eq!(display_name("example.com/plain").as_deref(), Some("plain"));
    }

    #[test]
    fn requirements_are_pinned_versions() {
        let mut out = Collector::default();
        collect(&[parse("go.mod", ".", GO_MOD)], &mut out);
        let cobra = out.find_dependency(".", "github.com/spf13/cobra").unwrap();
        assert_eq!(cobra.state, VersionState::Resolved);
        assert_eq!(cobra.resolved.as_deref(), Some("v1.8.0"));
        // "Contains Go code" stays a fact about source files, not about go.mod.
        assert!(!out.facts.iter().any(|f| f.tag() == Some("lang:go")));
        assert_eq!(
            out.coverage_status(".", "go"),
            Some(CoverageStatus::Complete)
        );
    }
}
