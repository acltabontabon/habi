//! Lineage that travels inside a shared skill: `metadata.based-on` in the
//! SKILL.md frontmatter, the Agent Skills format's own extension map, which
//! agents ignore. The value names the immediate parent a skill was refined
//! from: `<library identity>#<item id>@<version>`, for example
//! `github.com/obra/superpowers#brainstorming@8ca22db`.
//!
//! Edits are textual and minimal: only the `based-on` line (and, when
//! needed, a `metadata:` line) changes; the rest of the file keeps its exact
//! bytes. Frontmatter Habi cannot edit safely (an inline `metadata: {…}`, no
//! frontmatter at all) is left alone.

use serde_json::Value;

pub const KEY: &str = "based-on";

/// `<identity>#<item>@<short version>`.
pub fn lineage_value(identity: &str, item_id: &str, snapshot: &str) -> String {
    let short: String = snapshot
        .strip_prefix("sha256:")
        .unwrap_or(snapshot)
        .chars()
        .take(7)
        .collect();
    format!("{identity}#{item_id}@{short}")
}

/// The `based-on` value in parsed frontmatter, if any.
pub fn read(front: &serde_json::Map<String, Value>) -> Option<String> {
    front
        .get("metadata")?
        .get(KEY)?
        .as_str()
        .map(str::to_string)
        .filter(|v| !v.trim().is_empty())
}

/// The frontmatter's line range: (index of the opening `---` line, index of
/// the closing one), over `lines`.
fn frontmatter(lines: &[&str]) -> Option<(usize, usize)> {
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.trim_end() == "---")?
        .0;
    Some((0, close))
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn is_top_key(line: &str, key: &str) -> bool {
    line.strip_prefix(key)
        .is_some_and(|rest| rest.starts_with(':'))
}

/// Sets `metadata.based-on`, replacing an existing value. `None` when the
/// file cannot be edited safely.
#[allow(
    clippy::indexing_slicing,
    clippy::string_slice,
    reason = "line indexes stay below the frontmatter end found in the same list; `metadata:` is ASCII"
)]
pub fn set(text: &str, value: &str) -> Option<String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split(newline).collect();
    let (_, close) = frontmatter(&lines)?;
    let entry = |indent: &str| format!("{indent}{KEY}: {}", quote(value));
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    match (1..close).find(|&i| is_top_key(lines[i], "metadata")) {
        Some(m) => {
            let rest = lines[m]["metadata:".len()..].trim();
            if !rest.is_empty() && !rest.starts_with('#') {
                return None; // inline mapping: not edited
            }
            let children: Vec<usize> = (m + 1..close)
                .take_while(|&i| lines[i].starts_with([' ', '\t']) || lines[i].trim().is_empty())
                .collect();
            let indent: String = children
                .iter()
                .map(|&i| lines[i])
                .find(|l| !l.trim().is_empty())
                .map(|l| l.chars().take_while(|c| *c == ' ').collect())
                .unwrap_or_else(|| "  ".to_string());
            match children
                .iter()
                .find(|&&i| lines[i].trim_start().starts_with(&format!("{KEY}:")))
            {
                Some(&i) => out[i] = entry(&indent),
                None => out.insert(m + 1, entry(&indent)),
            }
        }
        None => {
            out.insert(close, entry("  "));
            out.insert(close, "metadata:".to_string());
        }
    }
    Some(out.join(newline))
}

/// Removes `metadata.based-on` (and a `metadata:` line left empty).
#[allow(
    clippy::indexing_slicing,
    reason = "line indexes stay below the frontmatter end found in the same list"
)]
pub fn remove(text: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split(newline).collect();
    let Some((_, close)) = frontmatter(&lines) else {
        return text.to_string();
    };
    let Some(m) = (1..close).find(|&i| is_top_key(lines[i], "metadata")) else {
        return text.to_string();
    };
    let children: Vec<usize> = (m + 1..close)
        .take_while(|&i| lines[i].starts_with([' ', '\t']))
        .collect();
    let Some(&line) = children
        .iter()
        .find(|&&i| lines[i].trim_start().starts_with(&format!("{KEY}:")))
    else {
        return text.to_string();
    };
    let drop_metadata = children.len() == 1 && lines[m].trim_end() == "metadata:";
    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != line && !(drop_metadata && *i == m))
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join(newline)
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: &str = "github.com/obra/superpowers#brainstorming@8ca22db";

    #[test]
    fn adds_a_metadata_block_and_keeps_everything_else() {
        let text = "---\nname: x\ndescription: Y.\n---\n# Body\n";
        let set = set(text, V).unwrap();
        assert_eq!(
            set,
            format!("---\nname: x\ndescription: Y.\nmetadata:\n  based-on: \"{V}\"\n---\n# Body\n")
        );
        assert_eq!(remove(&set), text);
    }

    #[test]
    fn joins_an_existing_metadata_block_with_its_indentation() {
        let text =
            "---\nname: x\nmetadata:\n    author: sre\n    version: \"2\"\nlicense: MIT\n---\nBody";
        let set = set(text, V).unwrap();
        assert!(set.contains(&format!(
            "metadata:\n    based-on: \"{V}\"\n    author: sre"
        )));
        assert!(set.ends_with("license: MIT\n---\nBody"));
        // Replacing keeps one line, and removing leaves the other keys.
        let again = super::set(&set, "local#y@1").unwrap();
        assert_eq!(again.matches("based-on").count(), 1);
        assert!(again.contains("based-on: \"local#y@1\""));
        assert_eq!(remove(&set), text);
    }

    #[test]
    fn leaves_what_it_cannot_edit_safely() {
        assert_eq!(set("# no frontmatter", V), None);
        assert_eq!(set("---\nmetadata: {a: b}\n---\n", V), None);
        assert_eq!(remove("---\nname: x\n---\n"), "---\nname: x\n---\n");
    }

    #[test]
    fn keeps_windows_line_endings() {
        let text = "---\r\nname: x\r\n---\r\nBody\r\n";
        let set = set(text, V).unwrap();
        assert!(set.contains("metadata:\r\n  based-on:"));
        assert!(!set.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn values_name_the_version_briefly() {
        assert_eq!(
            lineage_value("github.com/a/b", "s", "8ca22dba9a94"),
            "github.com/a/b#s@8ca22db"
        );
        assert_eq!(
            lineage_value("local:x", "s", "sha256:abcdef1234"),
            "local:x#s@abcdef1"
        );
    }
}
