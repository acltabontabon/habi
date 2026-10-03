//! The catalog registry: which public libraries Habi suggests, and how each
//! is read. Data lives in `catalog/sources.yaml`, embedded in the binary.
//!
//! Loading validates everything a later step relies on, so a bad entry fails
//! the build's tests rather than a person's screen: unique ids, addresses
//! Habi accepts, an owner that matches the address, evidence behind every
//! "official" claim, and path patterns and conditions that compile.

use crate::error::{HabiError, Result};
use crate::matching::condition::Condition;
use crate::source::{Location, parse_location, remote_identity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
use ts_rs::TS;

const EMBEDDED: &str = include_str!("../../catalog/sources.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum PublisherKind {
    /// The organisation behind the product or platform the skills are about.
    Builder,
    /// An independent maintainer.
    Community,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum OwnershipMethod {
    /// GitHub verifies the organisation.
    GithubVerifiedOrg,
    /// GitHub does not verify the organisation, but its declared website is
    /// the publisher's domain.
    OrgSiteMatchesDomain,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publisher {
    pub name: String,
    pub kind: PublisherKind,
    /// The account that owns the repository, as it appears in its address.
    pub owner: String,
    pub domain: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ownership {
    pub method: OwnershipMethod,
    /// The day the evidence was last checked (`YYYY-MM-DD`).
    pub checked: String,
}

/// Which version of a repository is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Track {
    /// The newest commit of the default branch.
    #[default]
    Default,
    /// The newest release tag (`v1.4.0`), or the default branch while the
    /// repository has published none. Only for a repository whose tags are
    /// versions.
    LatestRelease,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Discovery {
    #[serde(default)]
    pub track: Track,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Path segment (0 = first) whose folder names group the skills.
    pub group: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum StatusState {
    #[default]
    Active,
    Deprecated,
    Archived,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    #[serde(default)]
    pub state: StatusState,
    pub note: Option<String>,
    /// The catalog id that replaces this entry.
    pub successor: Option<String>,
}

/// A record that Habi inspected a library at a revision.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    /// The commit that was inspected.
    pub revision: String,
    pub date: String,
    pub by: String,
    /// What the inspection covered, in a sentence.
    pub scope: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHint {
    path: String,
    applies_when: Value,
}

/// A skill that applies to projects with specific, checkable features.
#[derive(Debug, Clone)]
pub struct Hint {
    /// Library-relative skill folder (glob).
    pub path: String,
    pub applies_when: Condition,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    id: String,
    name: String,
    url: String,
    summary: String,
    publisher: Publisher,
    ownership: Option<Ownership>,
    #[serde(default)]
    discovery: Discovery,
    #[serde(default)]
    status: Status,
    review: Option<Review>,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    hints: Vec<RawHint>,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub summary: String,
    pub publisher: Publisher,
    pub ownership: Option<Ownership>,
    pub discovery: Discovery,
    pub status: Status,
    pub review: Option<Review>,
    pub notes: Vec<String>,
    pub hints: Vec<Hint>,
}

impl Entry {
    /// `owner/name`, as people say it.
    pub fn repo(&self) -> String {
        owner_and_repo(&self.url)
            .map(|(owner, repo)| format!("{owner}/{repo}"))
            .unwrap_or_else(|| self.url.clone())
    }

    /// The identity a connected source of this repository has.
    pub fn identity(&self) -> String {
        remote_identity(&self.url).to_ascii_lowercase()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistry {
    version: u32,
    sources: Vec<RawEntry>,
}

#[derive(Debug, Clone)]
pub struct Registry {
    pub entries: Vec<Entry>,
}

impl Registry {
    pub fn get(&self, id: &str) -> Result<&Entry> {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| HabiError::NotFound(format!("catalog entry `{id}`")))
    }

    /// The registry built into this version of Habi.
    pub fn embedded() -> Result<&'static Registry> {
        static REGISTRY: OnceLock<std::result::Result<Registry, String>> = OnceLock::new();
        REGISTRY
            .get_or_init(|| Registry::parse(EMBEDDED).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| HabiError::Internal(format!("the library catalog is invalid: {e}")))
    }

    pub fn parse(text: &str) -> Result<Registry> {
        Self::parse_with(text, true)
    }

    /// `parse` without the rule that addresses are public https repositories
    /// owned by the named publisher, so tests can point entries at local
    /// repositories. Everything else is still checked.
    #[cfg(any(test, feature = "testing"))]
    pub fn parse_lenient(text: &str) -> Result<Registry> {
        Self::parse_with(text, false)
    }

    fn parse_with(text: &str, strict: bool) -> Result<Registry> {
        let raw: RawRegistry =
            serde_saphyr::from_str_with_options(text, crate::library::yaml_options())
                .map_err(|e| HabiError::invalid(format!("catalog: {e}")))?;
        if raw.version != 1 {
            return Err(HabiError::invalid(format!(
                "catalog: version {} is not supported",
                raw.version
            )));
        }
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        for raw in raw.sources {
            let entry = validate(raw, strict)?;
            if !seen.insert(entry.id.clone()) {
                return Err(HabiError::invalid(format!(
                    "catalog: id `{}` is used twice",
                    entry.id
                )));
            }
            entries.push(entry);
        }
        for e in &entries {
            if let Some(successor) = &e.status.successor
                && !entries.iter().any(|o| &o.id == successor)
            {
                return Err(bad(
                    &e.id,
                    format!("successor `{successor}` is not in the catalog"),
                ));
            }
        }
        Ok(Registry { entries })
    }
}

fn bad(id: &str, message: impl std::fmt::Display) -> HabiError {
    HabiError::invalid(format!("catalog entry `{id}`: {message}"))
}

/// `(owner, repository)` of a `https://github.com/<owner>/<repo>` address.
pub fn owner_and_repo(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

fn validate(raw: RawEntry, strict: bool) -> Result<Entry> {
    let id = raw.id.clone();
    let valid_id = !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_id {
        return Err(bad(
            &id,
            "the id must be lower-case letters, digits and hyphens",
        ));
    }
    if raw.name.trim().is_empty() || raw.name.len() > 80 {
        return Err(bad(&id, "the name must be 1–80 characters"));
    }
    if raw.summary.trim().is_empty() || raw.summary.len() > 200 {
        return Err(bad(&id, "the summary must be one short sentence"));
    }
    // Only public hosted repositories: a catalog entry is something anyone
    // can fetch without credentials.
    if strict {
        match parse_location(&raw.url) {
            Ok(Location::Remote(url)) if url.starts_with("https://") => {}
            _ => return Err(bad(&id, "the address must be an https repository URL")),
        }
        let Some((owner, _)) = owner_and_repo(&raw.url) else {
            return Err(bad(
                &id,
                "the address must look like https://github.com/<owner>/<repo>",
            ));
        };
        if !owner.eq_ignore_ascii_case(&raw.publisher.owner) {
            return Err(bad(
                &id,
                format!(
                    "the publisher's owner `{}` does not match the repository's owner `{owner}`",
                    raw.publisher.owner
                ),
            ));
        }
    }
    match (&raw.publisher.kind, &raw.ownership) {
        (PublisherKind::Builder, None) => {
            return Err(bad(&id, "a builder needs `ownership` evidence"));
        }
        (PublisherKind::Community, Some(_)) => {
            return Err(bad(
                &id,
                "a community source has no ownership claim to evidence",
            ));
        }
        _ => {}
    }
    if let Some(o) = &raw.ownership {
        if !is_date(&o.checked) {
            return Err(bad(&id, "`ownership.checked` must be a date (YYYY-MM-DD)"));
        }
        if o.method == OwnershipMethod::OrgSiteMatchesDomain && raw.publisher.domain.is_none() {
            return Err(bad(
                &id,
                "matching a site to a domain needs `publisher.domain`",
            ));
        }
    }
    if let Some(r) = &raw.review {
        let hex = r.revision.len() >= 7 && r.revision.chars().all(|c| c.is_ascii_hexdigit());
        if !hex || !is_date(&r.date) || r.by.trim().is_empty() || r.scope.trim().is_empty() {
            return Err(bad(
                &id,
                "a review needs a commit, a date, who did it and what it covered",
            ));
        }
    }
    // Compile patterns and conditions now, with the same rules sources use.
    crate::source::validate_scope(&raw.discovery.include).map_err(|e| bad(&id, e))?;
    crate::source::validate_scope(&raw.discovery.exclude).map_err(|e| bad(&id, e))?;
    let mut hints = Vec::new();
    for hint in raw.hints {
        crate::source::validate_scope(std::slice::from_ref(&hint.path)).map_err(|e| bad(&id, e))?;
        let applies_when = Condition::parse(&hint.applies_when)
            .map_err(|e| bad(&id, format!("hint for `{}`: {e}", hint.path)))?;
        hints.push(Hint {
            path: hint.path,
            applies_when,
        });
    }
    Ok(Entry {
        id: raw.id,
        name: raw.name,
        url: raw.url,
        summary: raw.summary,
        publisher: raw.publisher,
        ownership: raw.ownership,
        discovery: raw.discovery,
        status: raw.status,
        review: raw.review,
        notes: raw.notes,
        hints,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_yaml(extra: &str) -> String {
        format!(
            "version: 1\nsources:\n  - id: acme\n    name: Acme\n    url: https://github.com/acme/skills\n    summary: Skills.\n{extra}"
        )
    }

    const BUILDER: &str = "    publisher: { name: Acme, kind: builder, owner: acme }\n    ownership: { method: github-verified-org, checked: \"2026-10-03\" }\n";

    #[test]
    fn the_embedded_registry_is_valid() {
        let registry = Registry::embedded().unwrap();
        let ids: Vec<&str> = registry.entries.iter().map(|e| e.id.as_str()).collect();
        // The five original sources are kept, with their original ids.
        for id in [
            "anthropic",
            "superpowers",
            "addyosmani",
            "wshobson",
            "vercel",
        ] {
            assert!(ids.contains(&id), "{id} is missing from {ids:?}");
        }
        // The six additions.
        for id in [
            "openai",
            "microsoft",
            "google",
            "github",
            "cloudflare",
            "sentry",
        ] {
            assert!(ids.contains(&id), "{id} is missing from {ids:?}");
        }
    }

    #[test]
    fn no_entry_claims_a_review_nobody_did() {
        // Reviewed is its own attribute: shipping an entry as reviewed needs
        // a recorded inspection, and none has been done.
        for e in &Registry::embedded().unwrap().entries {
            assert!(e.review.is_none(), "{} claims a review", e.id);
        }
    }

    #[test]
    fn every_builder_has_evidence_and_no_community_source_does() {
        for e in &Registry::embedded().unwrap().entries {
            match e.publisher.kind {
                PublisherKind::Builder => assert!(e.ownership.is_some(), "{}", e.id),
                PublisherKind::Community => assert!(e.ownership.is_none(), "{}", e.id),
            }
        }
    }

    #[test]
    fn the_builders_and_the_community_are_as_listed() {
        let registry = Registry::embedded().unwrap();
        let kind = |id: &str| registry.get(id).unwrap().publisher.kind;
        for id in [
            "anthropic",
            "openai",
            "microsoft",
            "google",
            "github",
            "cloudflare",
            "vercel",
            "sentry",
        ] {
            assert_eq!(kind(id), PublisherKind::Builder, "{id}");
        }
        for id in ["superpowers", "addyosmani", "wshobson", "mattpocock"] {
            assert_eq!(kind(id), PublisherKind::Community, "{id}");
        }
    }

    #[test]
    fn cloudflare_is_official_by_its_site_not_by_a_github_badge() {
        let cloudflare = Registry::embedded().unwrap().get("cloudflare").unwrap();
        assert_eq!(
            cloudflare.ownership.as_ref().unwrap().method,
            OwnershipMethod::OrgSiteMatchesDomain
        );
    }

    #[test]
    fn repo_names_come_from_the_address() {
        let registry = Registry::embedded().unwrap();
        assert_eq!(
            registry.get("vercel").unwrap().repo(),
            "vercel-labs/agent-skills"
        );
        assert_eq!(registry.get("openai").unwrap().repo(), "openai/plugins");
        assert_eq!(
            owner_and_repo("https://github.com/a/b.git/"),
            Some(("a".into(), "b".into()))
        );
        assert_eq!(owner_and_repo("https://github.com/a/b/c"), None);
        assert_eq!(owner_and_repo("https://example.com/a/b"), None);
    }

    #[test]
    fn a_lookalike_owner_cannot_borrow_a_publisher() {
        let yaml = entry_yaml(
            "    publisher: { name: Acme, kind: builder, owner: acme-labs }\n    ownership: { method: github-verified-org, checked: \"2026-10-03\" }\n",
        );
        let err = Registry::parse(&yaml).unwrap_err().to_string();
        assert!(err.contains("does not match"), "{err}");
    }

    #[test]
    fn official_needs_evidence() {
        let yaml = entry_yaml("    publisher: { name: Acme, kind: builder, owner: acme }\n");
        let err = Registry::parse(&yaml).unwrap_err().to_string();
        assert!(err.contains("evidence"), "{err}");
        let yaml = entry_yaml(
            "    publisher: { name: Acme, kind: builder, owner: acme }\n    ownership: { method: org-site-matches-domain, checked: \"2026-10-03\" }\n",
        );
        let err = Registry::parse(&yaml).unwrap_err().to_string();
        assert!(err.contains("domain"), "{err}");
    }

    #[test]
    fn community_sources_do_not_claim_ownership() {
        let yaml = entry_yaml(
            "    publisher: { name: Someone, kind: community, owner: acme }\n    ownership: { method: github-verified-org, checked: \"2026-10-03\" }\n",
        );
        assert!(Registry::parse(&yaml).is_err());
        let ok = entry_yaml("    publisher: { name: Someone, kind: community, owner: acme }\n");
        assert!(Registry::parse(&ok).is_ok());
    }

    #[test]
    fn bad_addresses_ids_patterns_and_hints_are_rejected() {
        let bad_url = format!(
            "version: 1\nsources:\n  - id: a\n    name: A\n    url: ssh://git@github.com/acme/skills\n    summary: S.\n{BUILDER}"
        );
        assert!(Registry::parse(&bad_url).is_err());
        let not_github = format!(
            "version: 1\nsources:\n  - id: a\n    name: A\n    url: https://example.com/acme/skills\n    summary: S.\n{BUILDER}"
        );
        assert!(Registry::parse(&not_github).is_err());
        let bad_id = entry_yaml(BUILDER).replace("id: acme", "id: Not Valid");
        assert!(Registry::parse(&bad_id).is_err());
        let escape = entry_yaml(&format!(
            "{BUILDER}    discovery: {{ include: [\"../outside/**\"] }}\n"
        ));
        assert!(Registry::parse(&escape).is_err());
        let hint = entry_yaml(&format!(
            "{BUILDER}    hints:\n      - path: \"skills/*\"\n        applies_when: {{ script: \"rm -rf /\" }}\n"
        ));
        assert!(Registry::parse(&hint).is_err());
        let unknown_field = entry_yaml(&format!("{BUILDER}    skills: 12\n"));
        assert!(
            Registry::parse(&unknown_field).is_err(),
            "a hand-typed count has no place in the registry"
        );
    }

    #[test]
    fn duplicate_ids_and_dangling_successors_are_rejected() {
        let one = "  - id: acme\n    name: Acme\n    url: https://github.com/acme/skills\n    summary: Skills.\n    publisher: { name: Acme, kind: community, owner: acme }\n";
        let twice = format!("version: 1\nsources:\n{one}{one}");
        assert!(Registry::parse(&twice).is_err());
        let dangling = format!(
            "version: 1\nsources:\n{one}    status: {{ state: deprecated, successor: nope }}\n"
        );
        assert!(Registry::parse(&dangling).is_err());
    }

    #[test]
    fn every_hint_condition_compiles_and_its_path_is_a_skill_folder_glob() {
        for e in &Registry::embedded().unwrap().entries {
            for hint in &e.hints {
                assert!(!hint.path.ends_with("SKILL.md"), "{}: {}", e.id, hint.path);
            }
        }
    }
}
