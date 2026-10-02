//! The library catalog: public skill libraries Habi suggests, shown with what
//! is actually in them.
//!
//! The registry (`registry.rs`, `catalog/sources.yaml`) says which
//! repositories to suggest and how to read each one. Everything else about an
//! entry is read from the repository itself, by the same code that connects a
//! library:
//!
//! - **Preview** fetches a repository as a hidden source (`Source::preview`).
//!   It is cached, so it can be opened again offline, and it is kept out of
//!   every list, recommendation and installation until it is connected.
//! - **Connect** turns that preview into an ordinary library, keeping what was
//!   fetched. Nothing is installed or run.
//!
//! Nothing here fetches in the background. A preview is fetched when a person
//! asks for it, and refreshed when they ask for that.

pub mod github;
pub mod registry;

use crate::cancel::CancelToken;
use crate::error::{ErrorInfo, HabiError, Result};
use crate::library::model::LibraryIndex;
use crate::library::summary::{LibraryLicense, LibrarySummary, detect_spdx, summarize};
use crate::source::{
    CatalogBinding, Freshness, NewSource, Source, SourceKind, SourceRole, Sources,
    is_local_location, remote_identity,
};
use registry::{Entry, OwnershipMethod, PublisherKind, Registry, StatusState, Track};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Bump when what a summary counts changes, so stored ones are recomputed.
const SUMMARY_VERSION: u32 = 3;
/// Longest licence file read to name its licence.
const LICENSE_READ_LIMIT: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogAvailability {
    /// Not fetched: only the registry's description is known.
    NotFetched,
    /// Fetched for inspection; not connected.
    Previewed,
    /// A connected library.
    Connected,
}

/// Who is behind the repository, and what supports saying so. Ownership is
/// one fact; whether anyone at Habi has inspected the content is another.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogPublisher {
    pub name: String,
    pub kind: PublisherKind,
    /// The account that owns the repository.
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogOwnership {
    pub method: OwnershipMethod,
    /// The day this was last checked.
    pub checked: String,
    /// What was checked, in a sentence.
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogReview {
    pub revision: String,
    pub date: String,
    pub by: String,
    pub scope: String,
    /// The fetched library is still at the reviewed revision.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogStatus {
    pub state: StatusState,
    pub note: Option<String>,
    pub successor: Option<String>,
}

/// What was fetched of a library.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogFetched {
    pub snapshot: String,
    pub snapshot_at: Option<String>,
    /// The branch the repository's `HEAD` named at the last check.
    pub branch: Option<String>,
    /// The release tag this was read at (`v6.4.2`), if it was read at one.
    pub release: Option<String>,
    /// The newest commit: its subject, author and date.
    pub commit_summary: Option<String>,
    /// The date of the newest commit (`YYYY-MM-DD`).
    pub updated: Option<String>,
    pub freshness: Freshness,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TriggerKind {
    Dependency,
    File,
    Tag,
}

/// One feature of a project that makes the catalog suggest this library's
/// skills: a dependency, a file or a detected tag, as the registry's hints say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogTrigger {
    pub kind: TriggerKind,
    pub text: String,
}

/// The distinct project features the hints look for, in the order they are
/// written. A `not` branch is a reason to hold back, so it is left out.
fn triggers_of(entry: &Entry) -> Vec<CatalogTrigger> {
    use crate::matching::condition::Condition;
    fn walk(c: &Condition, out: &mut Vec<CatalogTrigger>) {
        let mut push = |kind, text: String| {
            let t = CatalogTrigger { kind, text };
            if !out.contains(&t) {
                out.push(t);
            }
        };
        match c {
            Condition::All { items } | Condition::Any { items } => {
                for i in items {
                    walk(i, out);
                }
            }
            Condition::Not { .. } => {}
            Condition::Dependency { name, .. } => push(TriggerKind::Dependency, name.clone()),
            Condition::File { glob } => push(
                TriggerKind::File,
                glob.strip_prefix("**/").unwrap_or(glob).to_string(),
            ),
            Condition::Tag { tag } => push(TriggerKind::Tag, crate::inspect::tags::phrase(tag)),
        }
    }
    let mut out = Vec::new();
    for h in &entry.hints {
        walk(&h.applies_when, &mut out);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    /// `owner/name`.
    pub repo: String,
    pub summary: String,
    pub notes: Vec<String>,
    pub publisher: CatalogPublisher,
    /// Present only for a builder whose ownership has been checked.
    pub ownership: Option<CatalogOwnership>,
    /// Present only when Habi has inspected the library and recorded it.
    pub review: Option<CatalogReview>,
    pub status: CatalogStatus,
    /// The folders of the repository that are read, as globs.
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    /// Read at the newest release tag, not the newest commit.
    pub follows_releases: bool,
    /// What in a project makes the catalog suggest this library's skills.
    pub fits_when: Vec<CatalogTrigger>,
    /// Path segment whose folder names group the skills.
    pub group_segment: Option<u32>,
    pub availability: CatalogAvailability,
    /// The source holding what was fetched (a preview, or the connected library).
    pub source_id: Option<String>,
    pub fetched: Option<CatalogFetched>,
    /// Counted from what was fetched.
    pub contents: Option<LibrarySummary>,
    /// Why the last attempt to reach the repository failed, if it did.
    pub problem: Option<ErrorInfo>,
}

/// The skills of one catalog library that fit a project.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogFit {
    pub entry_id: String,
    pub source_id: String,
    /// Already a connected library (not only previewed).
    pub connected: bool,
    pub fits: Vec<crate::recommend::Recommendation>,
}

pub struct Catalog<'a> {
    pub(crate) sources: &'a Sources,
    /// A registry other than the built-in one (tests).
    custom: Option<&'a Registry>,
}

#[derive(Serialize, Deserialize)]
struct StoredSummary {
    v: u32,
    summary: LibrarySummary,
}

fn evidence(entry: &Entry) -> Option<CatalogOwnership> {
    let ownership = entry.ownership.as_ref()?;
    let owner = &entry.publisher.owner;
    let text = match ownership.method {
        OwnershipMethod::GithubVerifiedOrg => {
            format!("GitHub shows the {owner} organization as verified")
        }
        OwnershipMethod::OrgSiteMatchesDomain => format!(
            "The {owner} organization is not verified by GitHub, but its website is {}",
            entry
                .publisher
                .domain
                .as_deref()
                .unwrap_or("the publisher's")
        ),
    };
    Some(CatalogOwnership {
        method: ownership.method,
        checked: ownership.checked.clone(),
        evidence: text,
    })
}

/// The date at the end of `describe_commit`'s `subject — author, date`.
fn commit_date(summary: &str) -> Option<String> {
    let date = summary.rsplit(", ").next()?;
    let ok = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    ok.then(|| date.to_string())
}

fn matches_entry(source: &Source, entry: &Entry) -> bool {
    if source.catalog_id.as_deref() == Some(entry.id.as_str()) {
        return true;
    }
    source.kind == SourceKind::Git
        && !is_local_location(&source.location)
        && remote_identity(&source.location).eq_ignore_ascii_case(&entry.identity())
}

impl<'a> Catalog<'a> {
    pub fn new(sources: &'a Sources) -> Catalog<'a> {
        Catalog {
            sources,
            custom: None,
        }
    }

    /// A catalog read from `registry` instead of the built-in one.
    pub fn with_registry(sources: &'a Sources, registry: &'a Registry) -> Catalog<'a> {
        Catalog {
            sources,
            custom: Some(registry),
        }
    }

    fn registry(&self) -> Result<&'a Registry> {
        match self.custom {
            Some(registry) => Ok(registry),
            None => Registry::embedded(),
        }
    }

    /// Every catalog entry, with what is known of each.
    pub fn entries(&self) -> Result<Vec<CatalogEntry>> {
        let registry = self.registry()?;
        let mut all = self.sources.list()?;
        all.extend(self.sources.list_previews()?);
        registry
            .entries
            .iter()
            .map(|entry| self.view(entry, Self::pick(&all, entry)))
            .collect()
    }

    pub fn entry(&self, id: &str) -> Result<CatalogEntry> {
        let entry = self.registry()?.get(id)?;
        let source = self.source_for(entry)?;
        self.view(entry, source.as_ref())
    }

    /// The connected source for an entry, else its preview.
    fn pick<'s>(all: &'s [Source], entry: &Entry) -> Option<&'s Source> {
        all.iter()
            .filter(|s| matches_entry(s, entry))
            .min_by_key(|s| s.preview)
    }

    fn source_for(&self, entry: &Entry) -> Result<Option<Source>> {
        let mut all = self.sources.list()?;
        all.extend(self.sources.list_previews()?);
        let Some(source) = Self::pick(&all, entry).cloned() else {
            return Ok(None);
        };
        // The registry says how a library is followed. One connected before
        // it said so is brought in line; what it has read stays until the
        // user updates it.
        let wanted = tracking(entry);
        if source.kind == SourceKind::Git && source.tracked != wanted {
            return self.sources.set_tracked(&source.id, &wanted).map(Some);
        }
        Ok(Some(source))
    }

    fn view(&self, entry: &Entry, source: Option<&Source>) -> Result<CatalogEntry> {
        let fetched = source.and_then(|s| {
            let snapshot = s.snapshot.clone()?;
            Some(CatalogFetched {
                updated: s.commit_summary.as_deref().and_then(commit_date),
                snapshot,
                snapshot_at: s.snapshot_at.clone(),
                release: self
                    .sources
                    .snapshot_ref(&s.id, &s.snapshot.clone()?)
                    .ok()
                    .flatten()
                    .and_then(|r| r.strip_prefix("tag ").map(str::to_string)),
                branch: s.default_branch.clone(),
                commit_summary: s.commit_summary.clone(),
                freshness: s.freshness,
                warning: s.warning.clone(),
            })
        });
        let contents = match (source, &fetched) {
            (Some(s), Some(_)) => self.contents_of(s, entry).unwrap_or_else(|e| {
                tracing::warn!(entry = %entry.id, error = %e, "could not read the cached library");
                None
            }),
            _ => None,
        };
        let review = entry.review.as_ref().map(|r| CatalogReview {
            current: fetched
                .as_ref()
                .is_some_and(|f| f.snapshot.starts_with(&r.revision)),
            revision: r.revision.clone(),
            date: r.date.clone(),
            by: r.by.clone(),
            scope: r.scope.clone(),
        });
        Ok(CatalogEntry {
            id: entry.id.clone(),
            name: entry.name.clone(),
            url: entry.url.clone(),
            repo: entry.repo(),
            summary: entry.summary.clone(),
            notes: entry.notes.clone(),
            publisher: CatalogPublisher {
                name: entry.publisher.name.clone(),
                kind: entry.publisher.kind,
                owner: entry.publisher.owner.clone(),
            },
            ownership: evidence(entry),
            review,
            status: CatalogStatus {
                state: entry.status.state,
                note: entry.status.note.clone(),
                successor: entry.status.successor.clone(),
            },
            include: entry.discovery.include.clone(),
            exclude: entry.discovery.exclude.clone(),
            follows_releases: entry.discovery.track == Track::LatestRelease,
            fits_when: triggers_of(entry),
            group_segment: entry.discovery.group,
            availability: match source {
                Some(s) if s.snapshot.is_some() && !s.preview => CatalogAvailability::Connected,
                Some(s) if s.snapshot.is_some() => CatalogAvailability::Previewed,
                Some(s) if !s.preview => CatalogAvailability::Connected,
                _ => CatalogAvailability::NotFetched,
            },
            source_id: source.map(|s| s.id.clone()),
            fetched,
            contents,
            problem: source.and_then(|s| s.last_error.clone()),
        })
    }

    /// The summary of a source's current snapshot: from the store when it was
    /// counted already, else counted now and stored.
    fn contents_of(&self, source: &Source, entry: &Entry) -> Result<Option<LibrarySummary>> {
        let Some(snapshot) = &source.snapshot else {
            return Ok(None);
        };
        if let Some(json) = self.sources.summary_json(&source.id, snapshot)?
            && let Ok(stored) = serde_json::from_str::<StoredSummary>(&json)
            && stored.v == SUMMARY_VERSION
        {
            return Ok(Some(stored.summary));
        }
        let index = self.sources.index_at(&source.id, snapshot)?;
        let summary = self.summarize_snapshot(source, snapshot, &index, entry);
        self.remember(&source.id, snapshot, &summary)?;
        Ok(Some(summary))
    }

    fn summarize_snapshot(
        &self,
        source: &Source,
        snapshot: &str,
        index: &LibraryIndex,
        entry: &Entry,
    ) -> LibrarySummary {
        summarize(
            index,
            entry.discovery.group,
            self.license_of(source, snapshot),
        )
    }

    fn remember(&self, id: &str, snapshot: &str, summary: &LibrarySummary) -> Result<()> {
        let json = serde_json::to_string(&StoredSummary {
            v: SUMMARY_VERSION,
            summary: summary.clone(),
        })
        .map_err(|e| HabiError::Internal(e.to_string()))?;
        self.sources.set_summary_json(id, snapshot, &json)
    }

    /// The repository's own licence, from its top-level licence file.
    fn license_of(&self, source: &Source, snapshot: &str) -> Option<LibraryLicense> {
        let files = self.sources.snapshot_files(&source.id, snapshot).ok()?;
        let mut candidates: Vec<&str> = files
            .iter()
            .map(|f| f.path.as_str())
            .filter(|p| !p.contains('/') && crate::library::is_license_file(p))
            .collect();
        candidates.sort_unstable();
        let file = (*candidates.first()?).to_string();
        let spdx = self
            .sources
            .read_file(&source.id, snapshot, &file)
            .ok()
            .filter(|bytes| bytes.len() <= LICENSE_READ_LIMIT)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| detect_spdx(&text).map(str::to_string));
        Some(LibraryLicense { file, spdx })
    }

    /// What GitHub says about an entry's repository (stars, forks, last push,
    /// archived), for the page of a library not yet connected. Kept for a
    /// day; the stale answer is used when GitHub cannot be reached; `None`
    /// when there is nothing to show. Never an error.
    pub fn repo_facts(&self, id: &str, cancel: &CancelToken) -> Result<Option<github::RepoFacts>> {
        self.repo_facts_with(id, &|owner, repo| github::fetch_repo(owner, repo, cancel))
    }

    /// `repo_facts` with the request supplied (tests use a stand-in).
    pub fn repo_facts_with(
        &self,
        id: &str,
        ask: &dyn Fn(&str, &str) -> Option<String>,
    ) -> Result<Option<github::RepoFacts>> {
        let entry = self.registry()?.get(id)?;
        let Some((owner, repo)) = registry::owner_and_repo(&entry.url) else {
            return Ok(None);
        };
        let key = format!("catalog:github:{}", entry.id);
        let cached: Option<github::RepoFacts> = self
            .sources
            .setting(&key)?
            .and_then(|json| serde_json::from_str(&json).ok());
        let now = crate::time::now();
        let fresh = cached.as_ref().is_some_and(|c| {
            crate::time::seconds_between(&c.fetched_at, &now)
                .is_some_and(|age| (0..github::TTL_SECONDS).contains(&age))
        });
        if fresh {
            return Ok(cached);
        }
        match ask(&owner, &repo).and_then(|json| github::parse_repo(&json, &now)) {
            Some(facts) => {
                if let Ok(json) = serde_json::to_string(&facts) {
                    self.sources.set_setting(&key, &json)?;
                }
                Ok(Some(facts))
            }
            // GitHub could not be asked: what was known before is better than nothing.
            None => Ok(cached),
        }
    }

    /// Fetches a library so it can be inspected, unless it was already
    /// fetched (then nothing is downloaded; pass `refresh` to check for
    /// changes). A connected library is returned as it is.
    pub fn preview(&self, id: &str, refresh: bool, cancel: &CancelToken) -> Result<CatalogEntry> {
        let entry = self.registry()?.get(id)?;
        let source = match self.source_for(entry)? {
            Some(s) => s,
            None => {
                let added = self.sources.add_with(
                    &NewSource {
                        name: format!("~preview:{}", entry.id),
                        location: entry.url.clone(),
                        subdir: None,
                        tracked: tracking(entry),
                    },
                    &CatalogBinding {
                        catalog_id: Some(entry.id.clone()),
                        include: entry.discovery.include.clone(),
                        exclude: entry.discovery.exclude.clone(),
                        preview: true,
                    },
                )?;
                // Libraries from the catalog are published by others, previewed or not.
                self.sources.set_role(&added.id, SourceRole::Community)?
            }
        };
        if source.snapshot.is_none() || (refresh && source.preview) {
            self.sources.refresh(&source.id, cancel)?;
        }
        // Count what was fetched now, so the next list is instant.
        let source = self.sources.get(&source.id)?;
        self.contents_of(&source, entry)?;
        self.view(entry, Some(&source))
    }

    /// Connects a catalog library: its preview becomes an ordinary library
    /// (fetching it first if needed). Nothing is installed.
    pub fn connect(&self, id: &str, cancel: &CancelToken) -> Result<Source> {
        let entry = self.registry()?.get(id)?;
        match self.source_for(entry)? {
            Some(source) if !source.preview => Ok(source),
            Some(source) => {
                if source.snapshot.is_none() {
                    self.sources.refresh(&source.id, cancel)?;
                }
                // Libraries from the catalog are published by others.
                self.sources
                    .connect_preview(&source.id, &entry.name, SourceRole::Community)
            }
            None => {
                let source = self.sources.add_with(
                    &NewSource {
                        name: entry.name.clone(),
                        location: entry.url.clone(),
                        subdir: None,
                        tracked: tracking(entry),
                    },
                    &CatalogBinding {
                        catalog_id: Some(entry.id.clone()),
                        include: entry.discovery.include.clone(),
                        exclude: entry.discovery.exclude.clone(),
                        preview: false,
                    },
                )?;
                self.sources.set_role(&source.id, SourceRole::Community)?;
                if let Err(e) = self.sources.refresh(&source.id, cancel) {
                    // A library that could not be fetched is not left half-connected.
                    let _ = self.sources.remove(&source.id);
                    return Err(e);
                }
                self.sources.get(&source.id)
            }
        }
    }

    /// Discards a fetched preview and what it cached. A connected library is
    /// not touched.
    pub fn forget(&self, id: &str) -> Result<()> {
        let entry = self.registry()?.get(id)?;
        if let Some(source) = self.source_for(entry)?
            && source.preview
        {
            self.sources.remove(&source.id)?;
        }
        Ok(())
    }
}

/// How a library from the catalog is followed.
fn tracking(entry: &Entry) -> crate::source::TrackedRef {
    match entry.discovery.track {
        Track::Default => crate::source::TrackedRef::Default,
        Track::LatestRelease => crate::source::TrackedRef::LatestRelease,
    }
}

/// An entry's hints, compiled once for a whole library.
pub struct Hints {
    matchers: Vec<(globset::GlobMatcher, crate::matching::condition::Condition)>,
}

impl Hints {
    /// The rule suggested for the skill folder at `path`, if any.
    pub fn find(&self, path: &str) -> Option<&crate::matching::condition::Condition> {
        self.matchers
            .iter()
            .find(|(m, _)| m.is_match(path))
            .map(|(_, c)| c)
    }

    pub fn is_empty(&self) -> bool {
        self.matchers.is_empty()
    }
}

/// The hints that apply to a connected or previewed source: the catalog
/// entry's, if the source is that entry's repository.
pub fn hints_for_source(source: &Source) -> Option<Hints> {
    let registry = Registry::embedded().ok()?;
    let entry = registry.entries.iter().find(|e| matches_entry(source, e))?;
    let matchers: Vec<_> = entry
        .hints
        .iter()
        .filter_map(|h| {
            let glob = globset::GlobBuilder::new(&h.path)
                .literal_separator(true)
                .build()
                .ok()?;
            Some((glob.compile_matcher(), h.applies_when.clone()))
        })
        .collect();
    (!matchers.is_empty()).then_some(Hints { matchers })
}
