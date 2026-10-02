//! Habi-managed sections inside Markdown instruction files.
//!
//! Habi owns only the text between its markers; everything else in the file
//! belongs to the team and is preserved byte for byte.
//!
//! ```text
//! <!-- habi:begin id=java-service-conventions -->
//! ...managed content...
//! <!-- habi:end id=java-service-conventions -->
//! ```

use crate::error::{HabiError, Result};
use crate::fsutil::sha256;

pub fn begin_marker(id: &str, note: &str) -> String {
    if note.is_empty() {
        format!("<!-- habi:begin id={id} -->")
    } else {
        format!("<!-- habi:begin id={id} {note} -->")
    }
}

pub fn end_marker(id: &str) -> String {
    format!("<!-- habi:end id={id} -->")
}

fn begin_id(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix("<!-- habi:begin id=")?;
    let rest = rest.strip_suffix("-->")?;
    rest.split_whitespace().next()
}

fn end_id(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix("<!-- habi:end id=")?;
    rest.strip_suffix("-->").map(str::trim)
}

/// Location of a managed section, in byte offsets of `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionSpan {
    /// Start of the begin-marker line.
    pub start: usize,
    /// Start of the content (after the begin-marker line).
    pub content_start: usize,
    /// End of the content (start of the end-marker line).
    pub content_end: usize,
    /// End of the end-marker line, including its newline.
    pub end: usize,
}

/// Finds the section `id`. Errors if markers are damaged (missing end,
/// duplicated begin), because guessing could destroy user text.
pub fn find(text: &str, id: &str) -> Result<Option<SectionSpan>> {
    let mut offset = 0;
    let mut open: Option<(usize, usize)> = None;
    let mut found: Option<SectionSpan> = None;
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        if begin_id(line) == Some(id) {
            if open.is_some() || found.is_some() {
                return Err(HabiError::Conflict(format!(
                    "the Habi section `{id}` appears more than once; fix the markers by hand"
                )));
            }
            open = Some((line_start, offset));
        } else if end_id(line) == Some(id) {
            let Some((start, content_start)) = open.take() else {
                return Err(HabiError::Conflict(format!(
                    "the end marker for Habi section `{id}` has no matching begin marker"
                )));
            };
            found = Some(SectionSpan {
                start,
                content_start,
                content_end: line_start,
                end: offset,
            });
        }
    }
    if open.is_some() {
        return Err(HabiError::Conflict(format!(
            "the Habi section `{id}` has no end marker; fix it by hand"
        )));
    }
    Ok(found)
}

/// Content of a section, normalized to end with a newline.
pub fn content<'a>(text: &'a str, span: &SectionSpan) -> &'a str {
    &text[span.content_start..span.content_end]
}

/// Section content as Habi compares it: LF line endings, no leading or
/// trailing blank lines, one final newline.
pub fn normalize(content: &str) -> String {
    let lf = content.replace("\r\n", "\n");
    let trimmed = lf.trim_matches('\n');
    format!("{trimmed}\n")
}

/// Digest of section content, independent of line-ending style.
pub fn digest(content: &str) -> String {
    sha256(normalize(content).as_bytes())
}

/// True if `content` is the section content recorded as `digest`. Accepts the
/// digest earlier versions recorded (line endings kept as they were), so
/// existing lock files stay valid.
pub fn digest_matches(content: &str, recorded: &str) -> bool {
    if digest(content) == recorded {
        return true;
    }
    let legacy = content.trim_matches('\n');
    sha256(format!("{legacy}\n").as_bytes()) == recorded
}

/// The line ending a file mostly uses: CRLF if most of its lines end with
/// CRLF (a Windows checkout with `core.autocrlf=true`), LF otherwise.
pub fn line_ending(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf { "\r\n" } else { "\n" }
}

/// Returns `text` with section `id` set to `body` (inserted at the end if
/// absent). The section uses the file's own line endings, so a CRLF file does
/// not end up with mixed line endings.
pub fn upsert(text: &str, id: &str, note: &str, body: &str) -> Result<String> {
    if body
        .lines()
        .any(|l| l.contains("<!-- habi:begin") || l.contains("<!-- habi:end"))
    {
        return Err(HabiError::invalid(
            "section text may not contain Habi section markers",
        ));
    }
    let eol = line_ending(text);
    let block = format!(
        "{}\n{}{}\n",
        begin_marker(id, note),
        normalize(body),
        end_marker(id)
    );
    let block = if eol == "\n" {
        block
    } else {
        block.replace('\n', eol)
    };
    let updated = match find(text, id)? {
        Some(span) => format!("{}{}{}", &text[..span.start], block, &text[span.end..]),
        None if text.is_empty() => block,
        None => {
            let sep = if text.ends_with("\n\n") || text.ends_with("\n\r\n") {
                String::new()
            } else if text.ends_with('\n') {
                eol.to_string()
            } else {
                format!("{eol}{eol}")
            };
            format!("{text}{sep}{block}")
        }
    };
    // The result must still parse as exactly one well-formed section.
    if find(&updated, id)?.is_none() {
        return Err(HabiError::Internal(format!(
            "could not write the `{id}` section"
        )));
    }
    Ok(updated)
}

/// Returns `text` without section `id` (and without the blank line Habi added before it).
pub fn remove(text: &str, id: &str) -> Result<String> {
    let Some(span) = find(text, id)? else {
        return Ok(text.to_string());
    };
    let mut before = text[..span.start].to_string();
    let after = &text[span.end..];
    if after.is_empty() {
        if before.ends_with("\r\n\r\n") {
            before.truncate(before.len() - 2);
        } else if before.ends_with("\n\n") {
            before.pop();
        }
    }
    Ok(format!("{before}{after}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_surrounding_text() {
        let original = "# Team notes\n\nKeep this.\n";
        let added = upsert(original, "java", "", "Rule one.").unwrap();
        assert!(added.starts_with(original));
        assert!(
            added.contains("<!-- habi:begin id=java -->\nRule one.\n<!-- habi:end id=java -->\n")
        );
        let span = find(&added, "java").unwrap().unwrap();
        assert_eq!(content(&added, &span), "Rule one.\n");
        let replaced = upsert(&added, "java", "", "Rule two.").unwrap();
        assert!(replaced.starts_with(original));
        assert!(!replaced.contains("Rule one"));
        assert_eq!(remove(&replaced, "java").unwrap(), original);
    }

    #[test]
    fn crlf_files_keep_crlf_and_digests_ignore_line_endings() {
        let original = "# Team notes\r\n\r\nKeep this.\r\n";
        let added = upsert(original, "java", "", "Rule one.\nRule two.\n").unwrap();
        assert!(added.starts_with(original));
        assert_eq!(
            added.matches('\n').count(),
            added.matches("\r\n").count(),
            "no lone LF in a CRLF file: {added:?}"
        );
        let span = find(&added, "java").unwrap().unwrap();
        let lf_digest = sha256(b"Rule one.\nRule two.\n");
        assert!(digest_matches(content(&added, &span), &lf_digest));
        assert_eq!(digest(content(&added, &span)), lf_digest);
        assert_eq!(remove(&added, "java").unwrap(), original);

        // An LF section converted to CRLF by Git still matches its digest.
        let lf = upsert("", "java", "", "Rule one.\n").unwrap();
        let converted = lf.replace('\n', "\r\n");
        let span = find(&converted, "java").unwrap().unwrap();
        assert!(digest_matches(
            content(&converted, &span),
            &sha256(b"Rule one.\n")
        ));
        // Digests recorded before line endings were normalized still match.
        let legacy = sha256(b"Rule one.\r\n");
        assert!(digest_matches("Rule one.\r\n", &legacy));
        assert!(!digest_matches("Rule two.\r\n", &legacy));
    }

    #[test]
    fn bodies_cannot_inject_markers() {
        assert!(upsert("", "a", "", "text\n<!-- habi:end id=a -->\nmore").is_err());
        assert!(upsert("", "a", "", "<!-- habi:begin id=b -->").is_err());
    }

    #[test]
    fn damaged_markers_are_conflicts() {
        assert!(find("<!-- habi:begin id=x -->\nno end\n", "x").is_err());
        assert!(find("text\n<!-- habi:end id=x -->\n", "x").is_err());
        let twice = "<!-- habi:begin id=x -->\na\n<!-- habi:end id=x -->\n<!-- habi:begin id=x -->\nb\n<!-- habi:end id=x -->\n";
        assert!(find(twice, "x").is_err());
        // Other ids are ignored.
        assert!(find("<!-- habi:begin id=y -->\n", "x").is_ok());
    }
}
