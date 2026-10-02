//! What a library holds, in numbers Habi can stand behind: counted from the
//! indexed snapshot, never typed in. Kept with the snapshot so a list of
//! libraries does not have to read every library to describe it.

use super::model::{DiagnosticLevel, ItemKind, LibraryIndex, LibraryItem};
use super::signals::{SignalCounts, SignalSeverity};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupCount {
    pub name: String,
    pub items: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryLicense {
    /// The licence file, library-relative.
    pub file: String,
    /// Its SPDX identifier when the text is one Habi recognises exactly;
    /// `None` otherwise. Habi does not guess.
    pub spdx: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibrarySummary {
    /// Skills, workflows and instructions.
    pub items: u32,
    /// Skills with at least one script.
    pub with_scripts: u32,
    /// Files in `scripts/` folders, or marked executable.
    pub script_files: u32,
    pub with_references: u32,
    pub with_assets: u32,
    /// Skills that cannot be installed (invalid, or with skipped files).
    pub unusable: u32,
    /// Skills with at least one caution signal.
    pub caution_items: u32,
    /// Skills whose most serious signal is a notice.
    pub notice_items: u32,
    pub signals: SignalCounts,
    /// How the skills fall into the registry's groups (plugins, categories).
    pub groups: Vec<GroupCount>,
    pub license: Option<LibraryLicense>,
}

/// The folder name at `segment` of an item's path, if the path goes deeper
/// than it (a skill folder itself is not a group).
pub fn group_of(path: &str, segment: u32) -> Option<&str> {
    let parts: Vec<&str> = path.split('/').collect();
    let at = usize::try_from(segment).ok()?;
    if parts.len() > at + 1 {
        parts.get(at).copied()
    } else {
        None
    }
}

fn has_prefix(item: &LibraryItem, prefix: &str) -> bool {
    item.files.iter().any(|f| f.path.starts_with(prefix))
}

pub fn summarize(
    index: &LibraryIndex,
    group_segment: Option<u32>,
    license: Option<LibraryLicense>,
) -> LibrarySummary {
    let mut summary = LibrarySummary {
        license,
        ..LibrarySummary::default()
    };
    let mut groups: BTreeMap<String, u32> = BTreeMap::new();
    for item in &index.items {
        summary.items += 1;
        let scripts = item
            .files
            .iter()
            .filter(|f| f.path.starts_with("scripts/") || f.executable)
            .count();
        if scripts > 0 && item.kind != ItemKind::Instructions {
            summary.with_scripts += 1;
            summary.script_files += u32::try_from(scripts).unwrap_or(u32::MAX);
        }
        if has_prefix(item, "references/") {
            summary.with_references += 1;
        }
        if has_prefix(item, "assets/") {
            summary.with_assets += 1;
        }
        let invalid = item
            .diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error);
        if invalid || !item.complete {
            summary.unusable += 1;
        }
        let counts = SignalCounts::of(&item.signals);
        summary.signals.add(counts);
        if counts.caution > 0 {
            summary.caution_items += 1;
        } else if counts.notice > 0 {
            summary.notice_items += 1;
        }
        if let Some(group) = group_segment.and_then(|g| group_of(&item.path, g)) {
            *groups.entry(group.to_string()).or_default() += 1;
        }
    }
    summary.groups = groups
        .into_iter()
        .map(|(name, items)| GroupCount { name, items })
        .collect();
    summary
}

/// The most serious signal an item carries, if any.
pub fn worst_signal(item: &LibraryItem) -> Option<SignalSeverity> {
    item.signals.iter().map(|s| s.severity).max()
}

/// The SPDX identifier of a licence text, when it is one of a few common
/// licences quoted in full. Anything else is `None`: a wrong answer about a
/// licence is worse than no answer.
pub fn detect_spdx(text: &str) -> Option<&'static str> {
    let flat: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let has = |needle: &str| flat.contains(needle);
    if has("apache license")
        && has("version 2.0")
        && has("terms and conditions for use, reproduction")
    {
        return Some("Apache-2.0");
    }
    if has("permission is hereby granted, free of charge, to any person obtaining a copy")
        && has("the above copyright notice and this permission notice shall be included")
    {
        return Some("MIT");
    }
    if has("gnu affero general public license") && has("version 3") {
        return Some("AGPL-3.0");
    }
    if has("gnu general public license") && has("version 3, 29 june 2007") {
        return Some("GPL-3.0");
    }
    if has("gnu general public license") && has("version 2, june 1991") {
        return Some("GPL-2.0");
    }
    if has("mozilla public license") && has("version 2.0") {
        return Some("MPL-2.0");
    }
    if has("redistribution and use in source and binary forms, with or without modification")
        && has("this software is provided by the copyright holders and contributors")
    {
        return Some(if has("neither the name of") {
            "BSD-3-Clause"
        } else {
            "BSD-2-Clause"
        });
    }
    if has("permission to use, copy, modify, and/or distribute this software for any purpose")
        && has("the software is provided \"as is\" and the author disclaims")
    {
        return Some("ISC");
    }
    if has("this is free and unencumbered software released into the public domain") {
        return Some("Unlicense");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIT: &str = "MIT License\n\nCopyright (c) 2025 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n";

    #[test]
    fn licences_are_named_only_when_the_text_is_unmistakable() {
        assert_eq!(detect_spdx(MIT), Some("MIT"));
        let apache = "Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION";
        assert_eq!(detect_spdx(apache), Some("Apache-2.0"));
        assert_eq!(detect_spdx("All rights reserved. Proprietary."), None);
        // A licence that merely mentions another is not that licence.
        assert_eq!(
            detect_spdx("Dual licensed; see the MIT License online."),
            None
        );
        assert_eq!(detect_spdx(""), None);
    }

    #[test]
    fn groups_come_from_path_segments_deeper_than_the_skill() {
        assert_eq!(group_of("plugins/zoom/skills/meet", 1), Some("zoom"));
        assert_eq!(group_of("skills/cloud/bigquery", 1), Some("cloud"));
        // A skill folder is not its own group.
        assert_eq!(group_of(".github/skills/foo", 2), None);
        assert_eq!(group_of("skills", 1), None);
    }
}
