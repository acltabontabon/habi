//! Skill names in visible prose. Package content is only read as data.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillMention {
    pub name: String,
    pub plugin: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompositionState {
    pub interrupted: bool,
    pub unmentioned: Vec<String>,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .split('-')
            .all(|word| !word.is_empty() && word.bytes().all(|c| c.is_ascii_lowercase()))
}

#[allow(
    clippy::string_slice,
    reason = "indices come from ASCII delimiters found in the same string"
)]
pub(crate) fn skill_mentions(body: &str) -> Vec<SkillMention> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut comment = false;
    for (number, line) in body.lines().enumerate() {
        if let Some((open, len)) = fence {
            let trimmed = line.trim_start_matches(' ');
            let run = trimmed.chars().take_while(|c| *c == open).count();
            if line.len() - trimmed.len() <= 3
                && run >= len
                && trimmed.get(run..).is_some_and(|s| s.trim().is_empty())
            {
                fence = None;
            }
            continue;
        }
        let mut visible = String::new();
        let mut rest = line;
        loop {
            if comment {
                if let Some(end) = rest.find("-->") {
                    rest = &rest[end + 3..];
                    comment = false;
                } else {
                    break;
                }
            } else if let Some(start) = rest.find("<!--") {
                visible.push_str(&rest[..start]);
                rest = &rest[start + 4..];
                comment = true;
            } else {
                visible.push_str(rest);
                break;
            }
        }
        let trimmed = visible.trim_start_matches(' ');
        if visible.len() - trimmed.len() <= 3
            && let Some(ch @ ('`' | '~')) = trimmed.chars().next()
        {
            let run = trimmed.chars().take_while(|c| *c == ch).count();
            if run >= 3 {
                match fence {
                    None => {
                        fence = Some((ch, run));
                        continue;
                    }
                    Some((open, len))
                        if ch == open
                            && run >= len
                            && trimmed.get(run..).is_some_and(|s| s.trim().is_empty()) =>
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
        let mut runs = Vec::new();
        let mut by_length: std::collections::HashMap<usize, std::collections::VecDeque<usize>> =
            std::collections::HashMap::new();
        let mut cursor = 0;
        while let Some(start) = visible
            .get(cursor..)
            .and_then(|s| s.find('`'))
            .map(|n| cursor + n)
        {
            let len = visible
                .get(start..)
                .unwrap_or_default()
                .bytes()
                .take_while(|b| *b == b'`')
                .count();
            runs.push((start, len));
            by_length.entry(len).or_default().push_back(start);
            cursor = start + len;
        }
        let mut consumed = 0;
        for (start, len) in runs {
            if start < consumed {
                continue;
            }
            let escapes = visible
                .get(..start)
                .unwrap_or_default()
                .bytes()
                .rev()
                .take_while(|b| *b == b'\\')
                .count();
            if escapes % 2 == 1 {
                continue;
            }
            let Some(starts) = by_length.get_mut(&len) else {
                continue;
            };
            while starts.front().is_some_and(|pos| *pos <= start) {
                starts.pop_front();
            }
            let Some(end) = starts.front().copied() else {
                continue;
            };
            consumed = end + len;
            let content = visible.get(start + len..end).unwrap_or_default();
            let rest = visible.get(consumed..).unwrap_or_default();
            let (plugin, name) = match content.split_once(':') {
                Some((plugin, name)) if valid_name(plugin) => (Some(plugin.to_string()), name),
                Some(_) => continue,
                None => (None, content),
            };
            let follows = rest.strip_prefix(" skill").is_some_and(|s| {
                s.chars()
                    .next()
                    .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
            });
            if valid_name(name) && (plugin.is_some() || follows) {
                out.push(SkillMention {
                    name: name.into(),
                    plugin,
                    line: (number + 1) as u32,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comments_inside_fences_do_not_hide_later_prose() {
        assert_eq!(
            skill_mentions("```\n<!--\n```\n`cedar` skill.")[0].name,
            "cedar"
        );
    }
    #[test]
    fn inline_spans_use_matching_runs_and_ignore_escaped_openers() {
        let body = "\\`hidden\\` skill, ``cedar`` skill. `unfinished ``elm`` skill.";
        assert_eq!(
            skill_mentions(body)
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            ["cedar", "elm"]
        );
    }
    #[test]
    fn visible_mentions() {
        let body = "`first` skill, `guild:second`\r\n`first` skills `first` skillful `Bad` skill `bad--name` skill\r\n```md\n`hidden` skill\n```\n<!-- `hidden` skill\n--> `third` skill.\n~~~\n`hidden` skill\n~~~";
        let mentions = skill_mentions(body);
        assert_eq!(
            mentions
                .iter()
                .map(|m| (m.name.as_str(), m.line))
                .collect::<Vec<_>>(),
            vec![("first", 1), ("second", 1), ("third", 7)]
        );
        assert_eq!(mentions[1].plugin.as_deref(), Some("guild"));
    }
}

use crate::clients::ClientId;
use crate::library::ComposeSource;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShelfSkill {
    pub key: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub origin: ShelfOrigin,
    pub source_label: String,
    pub library_url: Option<String>,
    pub item_id: Option<String>,
    pub digest: Option<String>,
    pub readers: Vec<ClientId>,
    pub cautions: Vec<String>,
    pub duplicates: u32,
    pub same_content: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Composition {
    pub dependencies: Vec<Dependency>,
    pub mentioned: Vec<MentionedSkill>,
    pub unmentioned: Vec<String>,
    pub cycles: Vec<Vec<String>>,
    pub incoming: Vec<IncomingRef>,
    pub context: ContextEstimate,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MentionedSkill {
    pub name: String,
    pub plugin: Option<String>,
    pub lines: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IncomingRef {
    pub skill_id: String,
    pub title: String,
    pub explicit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Dependency {
    pub name: String,
    pub roles: Vec<String>,
    pub optional: bool,
    pub from: Option<ComposeSource>,
    pub status: DependencyStatus,
    pub candidates: Vec<ShelfSkill>,
    pub exact: Option<String>,
    pub changed_since_linked: Option<bool>,
    pub availability: Vec<AgentAvailability>,
    pub nested: Vec<NestedRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NestedRef {
    pub name: String,
    pub explicit: bool,
    pub status: DependencyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentAvailability {
    pub client: ClientId,
    pub state: AvailabilityState,
    pub place: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextEstimate {
    pub discovery_tokens: u32,
    pub instructions_tokens: u32,
    pub files: Vec<FileEstimate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEstimate {
    pub path: String,
    pub kind: String,
    pub tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShelfOrigin {
    Mine,
    Machine,
    Project,
    Library,
    Community,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DependencyStatus {
    Exact,
    Named,
    Ambiguous,
    Missing,
    SelfReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AvailabilityState {
    Found,
    NotFound,
    Unknown,
}

impl super::Skills<'_> {
    /// Reads just the two composition documents, without scanning supporting files.
    pub(crate) fn composition_document(
        &self,
        id: &str,
    ) -> crate::error::Result<(super::SkillDocument, Vec<crate::library::ComposeEntry>)> {
        let _lock = self.lock(id)?;
        self.row(id)?;
        let dir = super::package_dir(self.paths, id)?;
        super::save::recover(&dir)?;
        read_document(&dir)
    }
}

pub(crate) fn read_document(
    dir: &std::path::Path,
) -> crate::error::Result<(super::SkillDocument, Vec<crate::library::ComposeEntry>)> {
    let path = crate::paths::resolve_for_read(
        dir,
        &crate::paths::RelPath::new(crate::library::SKILL_FILE)?,
    )?
    .ok_or_else(|| crate::error::HabiError::NotFound("SKILL.md".into()))?;
    let crate::fsutil::Bounded::Content(bytes) =
        crate::fsutil::read_bounded(&path, super::MAX_FILE_BYTES)?
    else {
        return Err(crate::error::HabiError::invalid(
            "SKILL.md is too large to read.",
        ));
    };
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| crate::error::HabiError::invalid("SKILL.md could not be read as text."))?;
    let (front, body) =
        crate::library::parse_frontmatter(text).map_err(crate::error::HabiError::invalid)?;
    let mut composes = Vec::new();
    for name in crate::library::SIDECAR_FILES {
        let path = crate::paths::resolve_for_read(dir, &crate::paths::RelPath::new(name)?)?;
        let Some(path) = path else {
            continue;
        };
        if let Ok(crate::fsutil::Bounded::Content(bytes)) =
            crate::fsutil::read_bounded(&path, super::MAX_FILE_BYTES)
            && let Ok(text) = std::str::from_utf8(&bytes)
            && let Ok(value) = crate::library::parse_yaml(text)
        {
            composes = crate::library::read_composes(&value);
        }
        break;
    }
    Ok((
        super::SkillDocument {
            name: front.name.unwrap_or_default(),
            description: front.description.unwrap_or_default(),
            body: body.trim_start_matches(['\n', '\r']).into(),
        },
        composes,
    ))
}
