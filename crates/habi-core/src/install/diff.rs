//! Readable line diffs for plan previews.

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff as SimilarDiff};
use ts_rs::TS;

const MAX_LINES: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LineTag {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffLine {
    pub tag: LineTag,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextDiff {
    pub hunks: Vec<Hunk>,
    pub added: u32,
    pub removed: u32,
    /// Content is not text; only sizes/digests are shown.
    pub binary: bool,
    /// The diff was cut to keep the preview readable.
    pub truncated: bool,
}

/// Diff of two optional byte buffers (`None` = file absent).
pub fn diff(old: Option<&[u8]>, new: Option<&[u8]>) -> TextDiff {
    let as_text = |b: Option<&[u8]>| -> Option<Option<String>> {
        match b {
            None => Some(None),
            Some(bytes) if crate::fsutil::is_probably_text(bytes) => {
                Some(Some(String::from_utf8_lossy(bytes).into_owned()))
            }
            Some(_) => None,
        }
    };
    let (Some(old_text), Some(new_text)) = (as_text(old), as_text(new)) else {
        return TextDiff {
            binary: true,
            ..Default::default()
        };
    };
    // Compare lines, not line endings: a CRLF checkout of an LF file would
    // otherwise show every line as removed and added with identical text.
    let old_text = old_text.unwrap_or_default().replace("\r\n", "\n");
    let new_text = new_text.unwrap_or_default().replace("\r\n", "\n");
    let d = SimilarDiff::from_lines(&old_text, &new_text);
    let mut result = TextDiff::default();
    let mut emitted = 0usize;
    for group in d.grouped_ops(3) {
        let (Some(first), Some(last)) = (group.first(), group.last()) else {
            continue;
        };
        let old_range = first.old_range().start..last.old_range().end;
        let new_range = first.new_range().start..last.new_range().end;
        let mut hunk = Hunk {
            header: format!(
                "@@ -{},{} +{},{} @@",
                old_range.start + 1,
                old_range.len(),
                new_range.start + 1,
                new_range.len()
            ),
            lines: Vec::new(),
        };
        for op in &group {
            for change in d.iter_changes(op) {
                let tag = match change.tag() {
                    ChangeTag::Equal => LineTag::Context,
                    ChangeTag::Insert => {
                        result.added += 1;
                        LineTag::Added
                    }
                    ChangeTag::Delete => {
                        result.removed += 1;
                        LineTag::Removed
                    }
                };
                if emitted >= MAX_LINES {
                    result.truncated = true;
                    continue;
                }
                emitted += 1;
                hunk.lines.push(DiffLine {
                    tag,
                    old_line: change.old_index().map(|i| i as u32 + 1),
                    new_line: change.new_index().map(|i| i as u32 + 1),
                    text: change.value().trim_end_matches(['\n', '\r']).to_string(),
                });
            }
        }
        if !hunk.lines.is_empty() {
            result.hunks.push(hunk);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_changes() {
        let d = diff(Some(b"a\nb\nc\n"), Some(b"a\nB\nc\nd\n"));
        assert_eq!(d.added, 2);
        assert_eq!(d.removed, 1);
        assert_eq!(d.hunks.len(), 1);
        let created = diff(None, Some(b"x\n"));
        assert_eq!(created.added, 1);
        assert!(diff(Some(&[0, 159, 146, 150]), Some(b"x")).binary);
    }

    #[test]
    fn line_endings_alone_are_not_line_changes() {
        let d = diff(Some(b"a\r\nb\r\nc\r\n"), Some(b"a\nB\nc\n"));
        assert_eq!((d.added, d.removed), (1, 1));
    }
}
