//! Which tag of a repository is its latest release.
//!
//! A release tag is a version number: `v6.4.2`, `0.6.11`, `2.0`. Anything else
//! is not a release — a pre-release (`v2.0.0-rc1`), a date or a commit hash
//! used as a name (as some repositories do) — and is ignored, so a library
//! never moves to something its publisher did not call a version.

/// The version a tag names, as its numeric parts. `None` if the tag is not a
/// plain version of two to four numbers with an optional leading `v`.
fn version(tag: &str) -> Option<Vec<u64>> {
    let digits = tag
        .strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag);
    let parts: Vec<&str> = digits.split('.').collect();
    if !(2..=4).contains(&parts.len()) {
        return None;
    }
    parts
        .iter()
        .map(|p| {
            // Digits only, and short: a long run of digits is a date or a hash.
            (!p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect()
}

/// The highest release among `tags`. Where two tags name the same version
/// (`v1.0` and `1.0.0`), the one that sorts last wins, so the answer does not
/// depend on the order the remote listed them in.
pub fn latest_release<'a>(tags: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut best: Option<(Vec<u64>, &str)> = None;
    for tag in tags {
        let Some(mut v) = version(tag) else { continue };
        // 1.0 and 1.0.0 are one version.
        while v.len() > 2 && v.last() == Some(&0) {
            v.pop();
        }
        let better = match &best {
            None => true,
            Some((bv, bt)) => (&v, tag) > (bv, bt),
        };
        if better {
            best = Some((v, tag));
        }
    }
    best.map(|(_, tag)| tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_highest_version_wins_by_number_not_by_text() {
        let tags = ["v1.9.0", "v1.10.0", "v1.2.0"];
        assert_eq!(latest_release(tags), Some("v1.10.0"));
        assert_eq!(
            latest_release(["0.6.9", "0.6.11", "0.6.10"]),
            Some("0.6.11")
        );
    }

    #[test]
    fn names_that_are_not_versions_are_not_releases() {
        assert_eq!(
            latest_release([
                "agent-skills-dd089a8c752c966dee8bf0f27cb625ba193ffd9e",
                "nightly",
                "v2.0.0-rc1",
                "20260102",
                "v1.2.3.4.5",
            ]),
            None
        );
        // A pre-release never beats the release before it.
        assert_eq!(latest_release(["v1.0.0", "v2.0.0-rc1"]), Some("v1.0.0"));
    }

    #[test]
    fn two_names_for_one_version_are_settled_the_same_way_every_time() {
        assert_eq!(latest_release(["v1.0", "1.0.0"]), Some("v1.0"));
        assert_eq!(latest_release(["1.0.0", "v1.0"]), Some("v1.0"));
    }

    #[test]
    fn no_tags_is_no_release() {
        assert_eq!(latest_release([]), None);
    }
}
