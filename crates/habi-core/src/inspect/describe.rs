//! A one-line description of the project, read from what its authors wrote.
//!
//! The root manifest's `description` wins; failing that, the first real
//! paragraph of the root README. Nothing is generated: a project with neither,
//! or with only starter-template boilerplate, has no description.

use crate::fsutil::read_prefix;
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

/// Longest description kept, in characters.
const MAX_CHARS: usize = 200;
/// Shortest description worth showing, in characters.
const MIN_CHARS: usize = 12;
/// How much of a README is read; the opening paragraph is near the top.
const README_BYTES: usize = 8 * 1024;
const MANIFEST_LIMIT: u64 = 512 * 1024;

static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static REF_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\[[^\]]*\]").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?[A-Za-z][^>]*>").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// The root README's path, whichever way it is cased.
pub fn readme_of(files: &[(String, u64)]) -> Option<&str> {
    const NAMES: [&str; 3] = ["readme.md", "readme.markdown", "readme.txt"];
    NAMES.iter().find_map(|wanted| {
        files
            .iter()
            .map(|(p, _)| p.as_str())
            .find(|p| !p.contains('/') && p.eq_ignore_ascii_case(wanted))
    })
}

pub fn describe(root: &Path, name: &str, files: &[(String, u64)]) -> Option<String> {
    let has = |file: &str| files.iter().any(|(p, _)| p == file);
    let manifest = [
        (
            "package.json",
            from_package_json as fn(&str) -> Option<String>,
        ),
        ("Cargo.toml", from_cargo_toml),
        ("pyproject.toml", from_pyproject),
        ("composer.json", from_composer_json),
    ]
    .into_iter()
    .filter(|(file, _)| has(file))
    .filter_map(|(file, read)| read(&read_text(root, file, MANIFEST_LIMIT)?))
    .find_map(|text| tidy(&text, name));
    manifest.or_else(|| {
        let text = read_text(root, readme_of(files)?, README_BYTES as u64)?;
        from_readme(&text).and_then(|p| tidy(&p, name))
    })
}

/// Reads a regular file (never a symlink), at most `limit` bytes of it.
fn read_text(root: &Path, rel: &str, limit: u64) -> Option<String> {
    let full = root.join(rel);
    let meta = std::fs::symlink_metadata(&full).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = read_prefix(&full, limit as usize).ok()?;
    // A manifest cut short is not valid; a README cut short is only shorter.
    if limit == MANIFEST_LIMIT && meta.len() > limit {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn from_package_json(text: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    json.get("description")?.as_str().map(str::to_string)
}

fn from_composer_json(text: &str) -> Option<String> {
    from_package_json(text)
}

fn from_cargo_toml(text: &str) -> Option<String> {
    let doc: toml::Table = text.parse().ok()?;
    ["package", "workspace"].iter().find_map(|section| {
        let table = doc.get(*section)?;
        let table = if *section == "workspace" {
            table.get("package")?
        } else {
            table
        };
        table.get("description")?.as_str().map(str::to_string)
    })
}

fn from_pyproject(text: &str) -> Option<String> {
    let doc: toml::Table = text.parse().ok()?;
    doc.get("project")
        .and_then(|p| p.get("description"))
        .or_else(|| {
            doc.get("tool")
                .and_then(|t| t.get("poetry"))
                .and_then(|p| p.get("description"))
        })?
        .as_str()
        .map(str::to_string)
}

/// The first paragraph that reads as prose: past the title, badges, logos,
/// tables, lists and code.
fn from_readme(text: &str) -> Option<String> {
    let mut paragraph = String::new();
    let mut in_fence = false;
    let mut in_comment = false;
    // Finishes the paragraph being collected; returns it if it is prose.
    let finish = |paragraph: &mut String| -> Option<String> {
        let text = std::mem::take(paragraph);
        let text = plain(&text);
        let words = text.split_whitespace().count();
        (words >= 3 && !text.ends_with(':')).then_some(text)
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if in_comment {
            in_comment = !trimmed.contains("-->");
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if trimmed.starts_with("<!--") {
            in_comment = !trimmed.contains("-->");
            continue;
        }
        // A bare `>` separates paragraphs inside a blockquote.
        if trimmed.trim_start_matches('>').trim().is_empty() {
            if let Some(p) = finish(&mut paragraph) {
                return Some(p);
            }
            continue;
        }
        let structural = trimmed.starts_with('#')
            || trimmed.starts_with('|')
            || trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed.starts_with("+ ")
            || trimmed.starts_with("---")
            || trimmed.starts_with("===")
            || trimmed.starts_with("***")
            || trimmed.starts_with("> [!")
            || trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
                && trimmed.split_once(['.', ')']).is_some_and(|(n, rest)| {
                    n.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(' ')
                });
        if structural {
            // Whatever came before it was a heading's neighbour, not prose
            // worth keeping unless it already read as a paragraph.
            if let Some(p) = finish(&mut paragraph) {
                return Some(p);
            }
            continue;
        }
        paragraph.push_str(trimmed.trim_start_matches('>').trim_start());
        paragraph.push(' ');
    }
    finish(&mut paragraph)
}

/// Plain text from a line of Markdown: no images, link targets, code ticks,
/// emphasis marks or HTML.
fn plain(text: &str) -> String {
    let text = IMAGE.replace_all(text, "");
    let text = LINK.replace_all(&text, "$1");
    let text = REF_LINK.replace_all(&text, "$1");
    let text = TAG.replace_all(&text, "");
    let text = text
        .replace(['`', '\u{a0}'], "")
        .replace("**", "")
        .replace("__", "");
    SPACES.replace_all(&text, " ").trim().to_string()
}

/// Cleans, vets and shortens a candidate. `None` if it is not worth showing.
fn tidy(text: &str, name: &str) -> Option<String> {
    let text = plain(text);
    if text.chars().count() < MIN_CHARS || !text.chars().any(char::is_alphabetic) {
        return None;
    }
    let lower = text.to_lowercase();
    let squash = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    };
    // The project's own name says nothing new.
    if squash(&text) == squash(name) {
        return None;
    }
    const BOILERPLATE_ANYWHERE: &[&str] = &[
        "bootstrapped with",
        "scaffolded with",
        "generated with",
        "this template",
        "lorem ipsum",
        "description goes here",
        "add a description",
    ];
    const BOILERPLATE_START: &[&str] = &[
        "a tauri app",
        "tauri +",
        "vite +",
        "react +",
        "getting started with",
    ];
    if BOILERPLATE_ANYWHERE.iter().any(|b| lower.contains(b))
        || BOILERPLATE_START.iter().any(|b| lower.starts_with(b))
    {
        return None;
    }
    Some(shorten(&text))
}

/// At most `MAX_CHARS`: the last whole sentence that fits, or the last whole word.
fn shorten(text: &str) -> String {
    if text.chars().count() <= MAX_CHARS {
        return text.to_string();
    }
    let head: Vec<char> = text.chars().take(MAX_CHARS).collect();
    // A sentence boundary far enough in to say something.
    let sentence = head
        .windows(2)
        .enumerate()
        .rev()
        .find(|(i, pair)| *i >= 60 && pair == &['.', ' ']);
    if let Some((i, _)) = sentence {
        return head.iter().take(i + 1).collect();
    }
    let cut = head.iter().rposition(|&c| c == ' ').unwrap_or(head.len());
    let words: String = head.iter().take(cut).collect();
    format!("{}…", words.trim_end_matches([',', ';', ':', '-', ' ']))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readme(text: &str) -> Option<String> {
        from_readme(text).and_then(|p| tidy(&p, "proj"))
    }

    #[test]
    fn readme_skips_title_badges_and_logo_to_the_first_prose() {
        let text = "# proj\n\n<p align=\"center\"><img src=\"logo.png\"></p>\n\n\
                    [![CI](https://x/y.svg)](https://x)\n[![npm](https://x/z.svg)](https://x)\n\n\
                    **proj** is a small [canvas](https://example.com) for drafting diagrams.\nIt runs offline.\n\n\
                    ## Install\n";
        assert_eq!(
            readme(text).as_deref(),
            Some("proj is a small canvas for drafting diagrams. It runs offline.")
        );
    }

    #[test]
    fn readme_accepts_a_blockquote_tagline_but_not_an_admonition() {
        assert_eq!(
            readme("# proj\n\n> Draft diagrams on an infinite canvas.\n").as_deref(),
            Some("Draft diagrams on an infinite canvas.")
        );
        assert_eq!(
            readme("# proj\n\n> Draft diagrams quickly.\n>\n> More detail follows.\n").as_deref(),
            Some("Draft diagrams quickly.")
        );
        assert_eq!(readme("# proj\n\n> [!NOTE]\n> Experimental.\n"), None);
    }

    #[test]
    fn readme_skips_code_comments_tables_and_lists() {
        let text = "# proj\n\n<!--\nhidden description here\n-->\n\n```sh\nnpm install proj now\n```\n\n\
                    | a | b |\n|---|---|\n\n- first item here\n- second\n\nTable of contents:\n\n\
                    A real sentence follows the clutter.\n";
        assert_eq!(
            readme(text).as_deref(),
            Some("A real sentence follows the clutter.")
        );
    }

    #[test]
    fn nothing_when_the_readme_has_no_prose() {
        assert_eq!(
            readme("# proj\n\n![logo](logo.png)\n\n## Usage\n\n```\nrun\n```\n"),
            None
        );
    }

    #[test]
    fn starter_boilerplate_is_not_a_description() {
        assert_eq!(
            readme("# app\n\nThis is a Next.js project bootstrapped with `create-next-app`.\n"),
            None
        );
        assert_eq!(tidy("A Tauri App", "proj"), None);
        assert_eq!(tidy("Tauri + React + Typescript", "proj"), None);
        assert_eq!(tidy("draft-canvas", "Draft Canvas"), None);
        assert_eq!(tidy("short", "proj"), None);
    }

    #[test]
    fn long_text_is_cut_at_a_sentence_or_a_word() {
        let sentence = "This sentence is long enough to count for something real. ";
        let long = sentence.repeat(6);
        let cut = tidy(&long, "proj").unwrap();
        assert!(cut.ends_with('.') && cut.chars().count() <= MAX_CHARS);
        let run = "word ".repeat(80);
        let cut = tidy(&run, "proj").unwrap();
        assert!(cut.ends_with("word…") && cut.chars().count() <= MAX_CHARS + 1);
    }

    #[test]
    fn manifests_come_before_the_readme_and_read_their_own_shape() {
        assert_eq!(
            from_package_json(r#"{"description":"A thing"}"#).as_deref(),
            Some("A thing")
        );
        assert_eq!(
            from_cargo_toml("[workspace.package]\ndescription = \"Shared\"\n").as_deref(),
            Some("Shared")
        );
        assert_eq!(
            from_cargo_toml("[package]\nname = \"a\"\ndescription = \"Own\"\n").as_deref(),
            Some("Own")
        );
        assert_eq!(
            from_pyproject("[tool.poetry]\ndescription = \"Poetic\"\n").as_deref(),
            Some("Poetic")
        );

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"description":"From the manifest."}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("README.md"),
            "# p\n\nFrom the readme, which loses.\n",
        )
        .unwrap();
        let files = vec![
            ("package.json".to_string(), 10),
            ("README.md".to_string(), 10),
        ];
        assert_eq!(
            describe(dir.path(), "proj", &files).as_deref(),
            Some("From the manifest.")
        );

        std::fs::write(
            dir.path().join("package.json"),
            r#"{"description":"A Tauri App"}"#,
        )
        .unwrap();
        assert_eq!(
            describe(dir.path(), "proj", &files).as_deref(),
            Some("From the readme, which loses.")
        );
    }

    #[test]
    fn readme_is_found_by_any_casing_at_the_root_only() {
        let files = vec![
            ("docs/README.md".to_string(), 1),
            ("Readme.md".to_string(), 1),
        ];
        assert_eq!(readme_of(&files), Some("Readme.md"));
        assert_eq!(readme_of(&[("docs/README.md".to_string(), 1)]), None);
    }
}
