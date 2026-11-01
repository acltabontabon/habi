use super::*;
use crate::library::{ComposeEntry, ComposeSource};
use crate::skills::compose::*;
use std::collections::{BTreeMap, BTreeSet};

fn title(name: &str) -> String {
    name.split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn row(
    key: String,
    name: String,
    description: String,
    origin: ShelfOrigin,
    source_label: String,
    digest: String,
) -> ShelfSkill {
    ShelfSkill {
        key,
        title: title(&name),
        name,
        description,
        origin,
        source_label,
        library_url: None,
        item_id: None,
        digest: (!digest.is_empty()).then_some(digest),
        readers: Vec::new(),
        cautions: Vec::new(),
        duplicates: 0,
        same_content: 0,
    }
}

fn resolve(
    name: &str,
    from: Option<&ComposeSource>,
    own: &str,
    shelf: &[ShelfSkill],
    libraries: &HashMap<String, String>,
) -> (
    DependencyStatus,
    Vec<ShelfSkill>,
    Option<String>,
    Option<bool>,
) {
    let candidates: Vec<_> = shelf.iter().filter(|s| s.name == name).cloned().collect();
    if name == own {
        return (DependencyStatus::SelfReference, candidates, None, None);
    }
    if let Some(from) = from
        && let (Some(library), Some(id)) = (&from.library, &from.id)
        && let Some(exact) = shelf.iter().find(|s| {
            s.item_id.as_ref() == Some(id)
                && libraries
                    .get(&s.key)
                    .or(s.library_url.as_ref())
                    .is_some_and(|url| crate::source::same_repository(url, library))
        })
    {
        let changed = from
            .digest
            .as_ref()
            .zip(exact.digest.as_ref())
            .map(|(a, b)| a != b);
        let mut candidates = candidates;
        if !candidates.iter().any(|s| s.key == exact.key) {
            candidates.push(exact.clone());
        }
        return (
            DependencyStatus::Exact,
            candidates,
            Some(exact.key.clone()),
            changed,
        );
    }
    let status = if candidates.is_empty() {
        DependencyStatus::Missing
    } else if candidates.len() == 1
        || (candidates.iter().all(|c| c.digest.is_some())
            && candidates
                .iter()
                .map(|c| &c.digest)
                .collect::<BTreeSet<_>>()
                .len()
                == 1)
    {
        DependencyStatus::Named
    } else {
        DependencyStatus::Ambiguous
    };
    (status, candidates, None, None)
}

fn metadata_title(dir: &Path) -> Option<String> {
    for name in crate::library::SIDECAR_FILES {
        let rel = crate::paths::RelPath::new(name).ok()?;
        let Some(path) = crate::paths::resolve_for_read(dir, &rel).ok().flatten() else {
            continue;
        };
        let crate::fsutil::Bounded::Content(bytes) =
            crate::fsutil::read_bounded(&path, 256 * 1024).ok()?
        else {
            return None;
        };
        let value = crate::library::parse_yaml(std::str::from_utf8(&bytes).ok()?).ok()?;
        return value
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    }
    None
}

#[derive(Clone)]
struct Node {
    name: String,
    composes: Vec<ComposeEntry>,
    body: String,
}

impl Habi {
    pub fn skill_shelf(&self) -> Result<Vec<ShelfSkill>> {
        let mut rows = Vec::new();
        for skill in self
            .skills()
            .list()?
            .into_iter()
            .filter(|s| s.deleted_at.is_none())
        {
            let mut r = row(
                format!("mine:{}", skill.id),
                skill.name,
                skill.description,
                ShelfOrigin::Mine,
                "My skills".into(),
                skill.content_digest,
            );
            r.title = skill.title;
            if skill.errors > 0 {
                r.cautions.push("Needs review".into());
            }
            rows.push(r);
        }
        for skill in self.machine_skills()? {
            let authored_title = crate::skills::machine::locate(&self.user_home, &skill.id)
                .ok()
                .and_then(|found| metadata_title(&found.path));
            let mut r = row(
                format!("machine:{}", skill.id),
                skill.name,
                skill.description,
                ShelfOrigin::Machine,
                "This machine".into(),
                skill.digest,
            );
            if let Some(title) = authored_title {
                r.title = title;
            }
            r.readers = skill.readers;
            if !skill.problems.is_empty() {
                r.cautions.push("Needs review".into());
            }
            if skill.is_link {
                r.cautions.push("Linked folder".into());
            }
            if !skill.mentions_home.is_empty() {
                r.cautions.push("Names a home folder".into());
            }
            rows.push(r);
        }
        for id in self.all_project_ids()? {
            let Ok(project) = self.project(&id) else {
                continue;
            };
            let Ok(knowledge) = self.discover(&id, &CancelToken::new()) else {
                continue;
            };
            for skill in knowledge.skills {
                let authored_title = crate::paths::RelPath::new(&skill.path)
                    .ok()
                    .and_then(|rel| {
                        crate::paths::resolve_for_read(&project.root, &rel)
                            .ok()
                            .flatten()
                    })
                    .and_then(|dir| metadata_title(&dir));
                let mut r = row(
                    format!("project:{id}/{}", skill.path),
                    skill.name,
                    skill.description,
                    ShelfOrigin::Project,
                    project.name.clone(),
                    skill.digest,
                );
                if let Some(title) = authored_title {
                    r.title = title;
                }
                r.readers = skill.readers;
                if !skill.problems.is_empty() {
                    r.cautions.push("Needs review".into());
                }
                rows.push(r);
            }
        }
        for source in self.sources.list()? {
            let Ok(index) = self.sources.index(&source.id) else {
                continue;
            };
            let origin = match source.role {
                crate::source::SourceRole::Team => ShelfOrigin::Library,
                crate::source::SourceRole::Community => ShelfOrigin::Community,
            };
            let url = (!crate::source::is_local_location(&source.location))
                .then(|| crate::source::remote_identity(&source.location));
            for skill in index
                .items
                .into_iter()
                .filter(|i| i.kind != crate::library::model::ItemKind::Instructions)
            {
                let mut r = row(
                    format!("library:{}/{}", source.id, skill.id),
                    skill.name,
                    skill.description,
                    origin,
                    source.name.clone(),
                    skill.content_digest,
                );
                r.title = skill.title;
                r.library_url = url.clone();
                r.item_id = Some(skill.id);
                r.cautions = skill.signals.iter().map(|s| s.summary.clone()).collect();
                if !skill.diagnostics.is_empty() {
                    r.cautions.push("Needs review".into());
                }
                rows.push(r);
            }
        }
        let mut counts: HashMap<String, (u32, HashMap<String, u32>)> = HashMap::new();
        for r in &rows {
            let (count, digests) = counts.entry(r.name.clone()).or_default();
            *count += 1;
            if let Some(digest) = &r.digest {
                *digests.entry(digest.clone()).or_default() += 1;
            }
        }
        for r in &mut rows {
            if let Some((count, digests)) = counts.get(&r.name) {
                r.duplicates = count.saturating_sub(1);
                r.same_content = r
                    .digest
                    .as_ref()
                    .and_then(|d| digests.get(d))
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(1);
            }
        }
        rows.sort_by_key(|r| (r.origin, r.title.to_lowercase(), r.key.clone()));
        Ok(rows)
    }

    fn composition_node(&self, key: &str) -> Result<Node> {
        if let Some(id) = key.strip_prefix("mine:") {
            let (document, composes) = self.skills().composition_document(id)?;
            return Ok(Node {
                name: document.name,
                composes,
                body: document.body,
            });
        }
        if let Some(rest) = key.strip_prefix("library:") {
            let (source, id) = rest
                .split_once('/')
                .ok_or_else(|| HabiError::invalid("Unknown skill."))?;
            let detail = self.item_detail(source, id)?;
            return Ok(Node {
                name: detail.item.name,
                composes: detail.item.composes,
                body: detail.body,
            });
        }
        let path = if let Some(id) = key.strip_prefix("machine:") {
            crate::skills::machine::locate(&self.user_home, id)?.path
        } else if let Some(rest) = key.strip_prefix("project:") {
            let (id, rel) = rest
                .split_once('/')
                .ok_or_else(|| HabiError::invalid("Unknown skill."))?;
            let project = self.existing_project(id)?;
            crate::paths::resolve_for_read(&project.root, &crate::paths::RelPath::new(rel)?)?
                .ok_or_else(|| HabiError::NotFound("skill".into()))?
        } else {
            return Err(HabiError::invalid("Unknown skill."));
        };
        let (document, composes) = crate::skills::compose::read_document(&path)?;
        Ok(Node {
            name: document.name,
            composes,
            body: document.body,
        })
    }

    pub fn skill_composition(&self, id: &str, project_id: Option<&str>) -> Result<Composition> {
        let skill = self.skills().get(id)?;
        let shelf = self.skill_shelf()?;
        let sources = self.sources.list()?;
        let libraries: HashMap<String, String> = shelf
            .iter()
            .filter_map(|row| {
                let source = sources
                    .iter()
                    .find(|source| row.key.starts_with(&format!("library:{}/", source.id)))?;
                Some((row.key.clone(), source.location.clone()))
            })
            .collect();
        let own = &skill.document.name;
        let mut clients = self.detected_clients(None).unwrap_or_default();
        clients.extend(self.detected_clients(project_id).unwrap_or_default());
        clients.sort();
        clients.dedup();
        let project = project_id.map(|id| self.discover(id, &CancelToken::new()));
        let installed = project_id.map(|id| {
            let project = self.existing_project(id)?;
            let lock = read_lock(&project.root)?;
            Ok::<_, HabiError>(self.installations(&project.root, &lock, &[]))
        });
        let machine_checked = self.user_home.is_dir()
            && crate::clients::layout::USER_SKILL_DIRS.iter().all(|dir| {
                match std::fs::read_dir(self.user_home.join(dir.base)) {
                    Ok(_) => true,
                    Err(error) => error.kind() == std::io::ErrorKind::NotFound,
                }
            });
        let mut cache = HashMap::new();
        cache.insert(
            format!("mine:{id}"),
            Node {
                name: own.clone(),
                composes: skill.composes.clone(),
                body: skill.document.body.clone(),
            },
        );
        let mut dependencies = Vec::new();
        let mut cycles = Vec::new();
        for entry in &skill.composes {
            let (status, candidates, exact, changed_since_linked) =
                resolve(&entry.skill, entry.from.as_ref(), own, &shelf, &libraries);
            let managed: Vec<_> = installed
                .as_ref()
                .and_then(|r| r.as_ref().ok())
                .into_iter()
                .flatten()
                .filter(|installation| {
                    installation.id == entry.skill
                        || candidates.iter().any(|candidate| {
                            candidate.item_id.as_ref() == Some(&installation.id)
                                && libraries
                                    .get(&candidate.key)
                                    .or(candidate.library_url.as_ref())
                                    .is_some_and(|url| {
                                        crate::source::same_repository(
                                            url,
                                            &installation.source_identity,
                                        )
                                    })
                        })
                })
                .collect();
            let mut clients = clients.clone();
            for installation in &managed {
                clients.extend(installation.clients.iter().copied());
            }
            for row in &candidates {
                clients.extend(row.readers.iter().copied());
            }
            clients.sort();
            clients.dedup();
            let availability = clients
                .iter()
                .map(|client| {
                    let machine = candidates
                        .iter()
                        .any(|s| s.origin == ShelfOrigin::Machine && s.readers.contains(client));
                    let in_project = managed.iter().any(|installation| {
                        installation.files.iter().any(|file| {
                            file.path.ends_with("/SKILL.md")
                                && file.state != crate::install::status::FileState::Missing
                                && crate::clients::layout::readers_of(&file.path).contains(client)
                        })
                    }) || project
                        .as_ref()
                        .and_then(|p| p.as_ref().ok())
                        .is_some_and(|p| {
                            p.skills
                                .iter()
                                .any(|s| s.name == entry.skill && s.readers.contains(client))
                        });
                    let state = if machine || in_project {
                        AvailabilityState::Found
                    } else if !machine_checked
                        || installed.as_ref().is_some_and(|r| r.is_err())
                        || project
                            .as_ref()
                            .is_some_and(|p| p.as_ref().map_or(true, |p| !p.limits.is_empty()))
                    {
                        AvailabilityState::Unknown
                    } else {
                        AvailabilityState::NotFound
                    };
                    let place = if machine {
                        Some("this machine".into())
                    } else if in_project {
                        project_id
                            .and_then(|id| self.project(id).ok())
                            .map(|p| p.name)
                    } else {
                        None
                    };
                    AgentAvailability {
                        client: *client,
                        state,
                        place,
                    }
                })
                .collect();
            let mut nested = Vec::new();
            let mut walk = Walk {
                habi: self,
                shelf: &shelf,
                libraries: &libraries,
                cache: &mut cache,
                visited: BTreeSet::new(),
                budget: 128,
                cycles: &mut cycles,
                nested: &mut nested,
            };
            let mut trail = vec![own.clone()];
            walk.edge(entry, own, &mut trail, 0);
            dependencies.push(Dependency {
                name: entry.skill.clone(),
                roles: entry.roles.clone(),
                optional: !entry.roles.is_empty()
                    && entry.roles.iter().all(|r| r == "if-available"),
                from: entry.from.clone(),
                status,
                candidates,
                exact,
                changed_since_linked,
                availability,
                nested,
            });
        }
        let mut mentioned: BTreeMap<(String, Option<String>), Vec<u32>> = BTreeMap::new();
        for mention in skill_mentions(&skill.document.body) {
            if !skill.composes.iter().any(|e| e.skill == mention.name) {
                mentioned
                    .entry((mention.name, mention.plugin))
                    .or_default()
                    .push(mention.line);
            }
        }
        let mut incoming = Vec::new();
        for row in shelf
            .iter()
            .filter(|r| r.origin == ShelfOrigin::Mine && r.key != format!("mine:{id}"))
        {
            if let Ok(node) = self.composition_node(&row.key) {
                let explicit = node.composes.iter().any(|e| e.skill == *own);
                if explicit || skill_mentions(&node.body).iter().any(|m| m.name == *own) {
                    incoming.push(IncomingRef {
                        skill_id: row.key.strip_prefix("mine:").unwrap_or_default().into(),
                        title: row.title.clone(),
                        explicit,
                    });
                }
            }
        }
        let tree = self.skills().tree(id)?;
        let files = skill
            .files
            .iter()
            .filter(|f| {
                f.path != "SKILL.md" && !crate::library::SIDECAR_FILES.contains(&f.path.as_str())
            })
            .map(|f| {
                let tokens =
                    tree.files.get(&f.path).filter(|_| f.text).map(|bytes| {
                        crate::suggest::tokens_of("", &String::from_utf8_lossy(bytes))
                    });
                FileEstimate {
                    path: f.path.clone(),
                    kind: material_kind(&f.path, f.executable).into(),
                    tokens,
                }
            })
            .collect();
        Ok(Composition {
            dependencies,
            mentioned: mentioned
                .into_iter()
                .map(|((name, plugin), mut lines)| {
                    lines.dedup();
                    MentionedSkill {
                        name,
                        plugin,
                        lines,
                    }
                })
                .collect(),
            unmentioned: skill.composition_state.unmentioned,
            cycles,
            incoming,
            context: ContextEstimate {
                discovery_tokens: crate::suggest::tokens_of(own, &skill.document.description),
                instructions_tokens: crate::suggest::tokens_of("", &skill.document.body),
                files,
            },
        })
    }
}

struct Walk<'a> {
    habi: &'a Habi,
    shelf: &'a [ShelfSkill],
    libraries: &'a HashMap<String, String>,
    cache: &'a mut HashMap<String, Node>,
    visited: BTreeSet<String>,
    budget: usize,
    cycles: &'a mut Vec<Vec<String>>,
    nested: &'a mut Vec<NestedRef>,
}
impl Walk<'_> {
    fn edge(&mut self, entry: &ComposeEntry, own: &str, trail: &mut Vec<String>, depth: usize) {
        if depth >= 4 || self.budget == 0 {
            return;
        }
        self.budget -= 1;
        let (status, candidates, exact, _) = resolve(
            &entry.skill,
            entry.from.as_ref(),
            own,
            self.shelf,
            self.libraries,
        );
        if !matches!(
            status,
            DependencyStatus::Named | DependencyStatus::Exact | DependencyStatus::SelfReference
        ) {
            return;
        }
        if let Some(pos) = trail.iter().position(|n| n == &entry.skill) {
            let mut cycle = trail.get(pos..).unwrap_or_default().to_vec();
            cycle.push(entry.skill.clone());
            if !self.cycles.contains(&cycle) {
                self.cycles.push(cycle);
            }
            return;
        }
        if !matches!(status, DependencyStatus::Named | DependencyStatus::Exact) {
            return;
        }
        let key = exact.or_else(|| candidates.first().map(|c| c.key.clone()));
        let Some(key) = key else {
            return;
        };
        if !self.visited.insert(key.clone()) {
            return;
        }
        if !self.cache.contains_key(&key)
            && let Ok(node) = self.habi.composition_node(&key)
        {
            self.cache.insert(key.clone(), node);
        }
        let Some(node) = self.cache.get(&key).cloned() else {
            return;
        };
        if depth + 1 >= 4 {
            return;
        }
        trail.push(node.name.clone());
        for child in &node.composes {
            let (status, _, _, _) = resolve(
                &child.skill,
                child.from.as_ref(),
                &node.name,
                self.shelf,
                self.libraries,
            );
            self.nested.push(NestedRef {
                name: child.skill.clone(),
                explicit: true,
                status,
            });
            self.edge(child, &node.name, trail, depth + 1);
        }
        for mention in skill_mentions(&node.body) {
            if !node.composes.iter().any(|e| e.skill == mention.name) {
                let (status, _, _, _) =
                    resolve(&mention.name, None, &node.name, self.shelf, self.libraries);
                self.nested.push(NestedRef {
                    name: mention.name,
                    explicit: false,
                    status,
                });
            }
        }
        trail.pop();
    }
}

fn material_kind(path: &str, executable: bool) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let top = path.split('/').next().unwrap_or_default().to_lowercase();
    let ext = name.rsplit('.').next().unwrap_or_default();
    let stem = name.split('.').next().unwrap_or_default();
    if matches!(stem, "license" | "licence" | "notice" | "copying") {
        "other"
    } else if matches!(top.as_str(), "examples" | "example")
        || name
            .split(['_', '-', '.'])
            .any(|s| matches!(s, "example" | "examples"))
    {
        "example"
    } else if matches!(top.as_str(), "scripts" | "bin") || executable {
        "script"
    } else if matches!(top.as_str(), "references" | "reference" | "docs") {
        "reference"
    } else if matches!(top.as_str(), "assets" | "templates")
        || matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico")
    {
        "asset"
    } else if matches!(
        ext,
        "md" | "markdown" | "txt" | "rst" | "adoc" | "pdf" | "html" | "htm"
    ) {
        "reference"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_ambiguous_edge_does_not_claim_a_cycle() {
        let temp = tempfile::tempdir().unwrap();
        let habi = Habi::open(AppPaths::at(temp.path().into())).unwrap();
        let first = row(
            "mine:a".into(),
            "birch".into(),
            "".into(),
            ShelfOrigin::Mine,
            "My skills".into(),
            "first".into(),
        );
        let second = row(
            "machine:a".into(),
            "birch".into(),
            "".into(),
            ShelfOrigin::Machine,
            "This machine".into(),
            "second".into(),
        );
        let cedar = row(
            "mine:b".into(),
            "cedar".into(),
            "".into(),
            ShelfOrigin::Mine,
            "My skills".into(),
            "third".into(),
        );
        let shelf = [first, second, cedar];
        let libraries = HashMap::new();
        let mut cache = HashMap::from([(
            "mine:b".into(),
            Node {
                name: "cedar".into(),
                body: "".into(),
                composes: vec![ComposeEntry {
                    skill: "birch".into(),
                    roles: vec![],
                    from: None,
                }],
            },
        )]);
        let mut cycles = Vec::new();
        let mut nested = Vec::new();
        let mut walk = Walk {
            habi: &habi,
            shelf: &shelf,
            libraries: &libraries,
            cache: &mut cache,
            visited: BTreeSet::new(),
            budget: 128,
            cycles: &mut cycles,
            nested: &mut nested,
        };
        walk.edge(
            &ComposeEntry {
                skill: "cedar".into(),
                roles: vec![],
                from: None,
            },
            "birch",
            &mut vec!["birch".into()],
            0,
        );
        assert!(cycles.is_empty());
        assert_eq!(nested[0].status, DependencyStatus::Ambiguous);
    }

    #[test]
    fn resolution_uses_evidence_without_equating_named_with_exact() {
        let a = row(
            "library:forest/cedar".into(),
            "cedar".into(),
            "Review changes.".into(),
            ShelfOrigin::Library,
            "Forest".into(),
            "sha256:first".into(),
        );
        let mut b = a.clone();
        b.key = "mine:cedar".into();
        b.origin = ShelfOrigin::Mine;
        let libraries = HashMap::from([(
            a.key.clone(),
            "https://user:secret@example.invalid/forest.git".into(),
        )]);
        assert_eq!(
            resolve("cedar", None, "birch", &[a.clone(), b.clone()], &libraries).0,
            DependencyStatus::Named
        );
        b.digest = Some("sha256:second".into());
        let shelf = [a.clone(), b];
        assert_eq!(
            resolve("cedar", None, "birch", &shelf, &libraries).0,
            DependencyStatus::Ambiguous
        );
        let mut shelf = shelf.to_vec();
        shelf[0].item_id = Some("cedar".into());
        let from = ComposeSource {
            library: Some("ssh://example.invalid/forest".into()),
            id: Some("cedar".into()),
            digest: Some("sha256:older".into()),
        };
        let (status, _, exact, changed) =
            resolve("cedar", Some(&from), "birch", &shelf, &libraries);
        assert_eq!(status, DependencyStatus::Exact);
        assert_eq!(exact, Some(a.key));
        assert_eq!(changed, Some(true));
        assert_eq!(
            resolve("cedar", Some(&from), "cedar", &shelf, &libraries).0,
            DependencyStatus::SelfReference
        );
        assert_eq!(
            resolve("elm", None, "birch", &shelf, &libraries).0,
            DependencyStatus::Missing
        );
    }
}
