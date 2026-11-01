//! Composition travels as ordinary package files between independent homes.
mod common;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::ContributionOrigin;
use habi_core::error::HabiError;
use habi_core::install::plan::Decisions;
use habi_core::library::{ComposeEntry, ComposeSource};
use habi_core::service::{Habi, ImportFrom, ItemRef};
use habi_core::skills::compose::{AvailabilityState, DependencyStatus, ShelfOrigin};
use habi_core::skills::intake::ImportSelection;
use habi_core::skills::{LOCAL_SOURCE_ID, LocalSkill, NewSkill, SkillTemplate};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::process::Command;

fn open(home: &Path) -> Habi {
    Habi::open(AppPaths::at(home.to_path_buf()))
        .unwrap()
        .with_user_home(home.join("person"))
}
fn draft(h: &Habi, name: &str, body: &str, entries: Option<Vec<ComposeEntry>>) -> LocalSkill {
    let skill = h
        .create_skill(
            &NewSkill {
                title: name.into(),
                description: "Review fictional changes before sharing them.".into(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    let mut document = skill.document.clone();
    document.body = body.into();
    h.skills()
        .save_document(
            &skill.summary.id,
            name,
            &document,
            skill.document_digest.as_deref(),
            entries,
            None,
        )
        .unwrap()
}
fn entry(name: &str) -> ComposeEntry {
    ComposeEntry {
        skill: name.into(),
        roles: vec!["when-relevant".into(), "after".into(), "future-role".into()],
        from: None,
    }
}
fn import(h: &Habi, path: &Path) -> LocalSkill {
    let from = ImportFrom::Folder {
        path: path.to_string_lossy().into_owned(),
    };
    let inspect = h.inspect_import(&from, &CancelToken::new()).unwrap();
    let outcome = h
        .import_skills(
            &from,
            &[ImportSelection {
                path: inspect.candidates[0].path.clone(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    h.skills().get(&outcome.imported[0].id).unwrap()
}
fn connect(h: &Habi, folder: &Path) -> String {
    let source = h
        .sources()
        .add(&NewSource {
            name: "Fictional guild".into(),
            location: folder.to_string_lossy().into_owned(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    h.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    source.id
}

// Read only Habi's own test export, so the portability test also runs without
// an external unzip tool. This is not an importer for arbitrary archives.
fn unpack_export(zip: &Path, dest: &Path) {
    use std::io::Read;
    let bytes = std::fs::read(zip).unwrap();
    let short = |at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
    let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let mut at = 0;
    while bytes.get(at..at + 4) == Some(b"PK\x03\x04") {
        let method = short(at + 8);
        let length = word(at + 18) as usize;
        let name_length = short(at + 26);
        let start = at + 30 + name_length + short(at + 28);
        let name = std::str::from_utf8(&bytes[at + 30..at + 30 + name_length]).unwrap();
        let rel = habi_core::paths::RelPath::new(name).unwrap();
        let raw = &bytes[start..start + length];
        let mut content = Vec::new();
        match method {
            0 => content.extend_from_slice(raw),
            8 => {
                flate2::read::DeflateDecoder::new(raw)
                    .read_to_end(&mut content)
                    .unwrap();
            }
            _ => panic!("Unexpected compression in Habi's export"),
        }
        assert_eq!(crc32fast::hash(&content), word(at + 14));
        assert_eq!(content.len(), word(at + 22) as usize);
        let target = dest.join(rel.as_str());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
        at = start + length;
    }
    assert_eq!(bytes.get(at..at + 4), Some(b"PK\x01\x02".as_slice()));
}

#[test]
fn zip_between_independent_homes_keeps_body_composes_and_comments() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let h = open(first.path());
    let other = open(second.path());
    let body = "When reviewing a change, use the `cedar-review` skill.\r\n";
    let skill = draft(&h, "birch-plan", body, Some(vec![entry("cedar-review")]));
    let meta = format!(
        "# Keep this note.\n{}",
        skill.metadata_text.as_deref().unwrap()
    );
    let skill = h
        .skills()
        .save_metadata_text(&skill.summary.id, &meta, skill.metadata_digest.as_deref())
        .unwrap();
    let bytes =
        std::fs::read(h.skills().file_path(&skill.summary.id, "SKILL.md").unwrap()).unwrap();
    let zip = first.path().join("skill.zip");
    h.skills().export_zip(&skill.summary.id, &zip).unwrap();
    // The existing importer accepts folders. Unpack the exported zip first.
    let unpacked = second.path().join("unpacked");
    unpack_export(&zip, &unpacked);
    let imported = import(&other, &unpacked);
    assert_eq!(
        std::fs::read(
            other
                .skills()
                .file_path(&imported.summary.id, "SKILL.md")
                .unwrap()
        )
        .unwrap(),
        bytes
    );
    assert_eq!(imported.document.body, body);
    assert_eq!(imported.composes, skill.composes);
    assert_eq!(imported.metadata_text, Some(meta));
    assert_eq!(
        other
            .skill_composition(&imported.summary.id, None)
            .unwrap()
            .dependencies[0]
            .status,
        DependencyStatus::Missing
    );
    draft(&other, "cedar-review", "Review the change.\n", None);
    assert_eq!(
        other
            .skill_composition(&imported.summary.id, None)
            .unwrap()
            .dependencies[0]
            .status,
        DependencyStatus::Named
    );
}

#[test]
fn git_library_link_resolves_exact_and_tracks_changed_content() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let h = open(home.path());
    std::fs::create_dir(repo.path().join("cedar-review")).unwrap();
    std::fs::write(
        repo.path().join("cedar-review/SKILL.md"),
        "---\nname: cedar-review\ndescription: Review fictional changes.\n---\nCheck the change.\n",
    )
    .unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Example",
            "-c",
            "user.email=example@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Start",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .status()
                .unwrap()
                .success()
        );
    }
    let source_id = connect(&h, repo.path());
    let index = h.sources().index(&source_id).unwrap();
    let mut linked = entry("cedar-review");
    linked.from = Some(ComposeSource {
        library: Some(h.sources().get(&source_id).unwrap().location),
        id: Some(index.items[0].id.clone()),
        digest: Some(index.items[0].content_digest.clone()),
    });
    let skill = draft(
        &h,
        "birch-plan",
        "Use `cedar-review` skill.\n",
        Some(vec![linked]),
    );
    let cache = h.sources().cache_dir(&source_id);
    for args in [
        ["config", "user.name", "Example"],
        ["config", "user.email", "example@example.invalid"],
        ["config", "commit.gpgsign", "false"],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&cache)
                .status()
                .unwrap()
                .success()
        );
    }
    let contribution = h
        .start_contribution(
            &source_id,
            ContributionOrigin::LocalSkill {
                skill_id: skill.summary.id.clone(),
            },
        )
        .unwrap();
    let committed = h
        .commit_contribution(&contribution.id, &CancelToken::new())
        .unwrap();
    h.publish_contribution(&contribution.id, false, &CancelToken::new())
        .unwrap();
    assert!(
        Command::new("git")
            .args(["merge", "--ff-only", &committed.branch])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success()
    );
    let second = tempfile::tempdir().unwrap();
    let other = open(second.path());
    let other_source = connect(&other, repo.path());
    let from = ImportFrom::Library {
        source_id: other_source,
    };
    let inspection = other.inspect_import(&from, &CancelToken::new()).unwrap();
    let published = inspection
        .candidates
        .iter()
        .find(|c| c.name == "birch-plan")
        .unwrap();
    let imported = other
        .import_skills(
            &from,
            &[ImportSelection {
                path: published.path.clone(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    let rebuilt = other
        .skill_composition(&imported.imported[0].id, None)
        .unwrap();
    assert_eq!(rebuilt.dependencies[0].status, DependencyStatus::Exact);
    assert_eq!(rebuilt.dependencies[0].roles, skill.composes[0].roles);
    let composition = h.skill_composition(&skill.summary.id, None).unwrap();
    assert_eq!(composition.dependencies[0].status, DependencyStatus::Exact);
    assert_eq!(
        composition.dependencies[0].changed_since_linked,
        Some(false)
    );
    assert!(
        composition.dependencies[0]
            .exact
            .as_ref()
            .unwrap()
            .starts_with("library:")
    );
    assert!(
        !serde_json::to_string(&h.skill_shelf().unwrap())
            .unwrap()
            .contains("secret")
    );
}

#[test]
fn conflicts_change_neither_file_and_body_only_leaves_metadata_bytes() {
    let home = tempfile::tempdir().unwrap();
    let h = open(home.path());
    let skill = draft(
        &h,
        "birch-plan",
        "Use `cedar-review` skill.\n",
        Some(vec![entry("cedar-review")]),
    );
    let path = h.skills().file_path(&skill.summary.id, "SKILL.md").unwrap();
    let meta = path.parent().unwrap().join("habi.yaml");
    let original = std::fs::read(&path).unwrap();
    let original_meta = std::fs::read(&meta).unwrap();
    let mut doc = skill.document.clone();
    doc.body = "Use `cedar-review` skill again.\n".into();
    for (body_base, meta_base, file) in [
        (Some("stale"), skill.metadata_digest.as_deref(), "SKILL.md"),
        (skill.document_digest.as_deref(), Some("stale"), "habi.yaml"),
    ] {
        let err = h
            .skills()
            .save_document(
                &skill.summary.id,
                "Plan",
                &doc,
                body_base,
                Some(vec![]),
                meta_base,
            )
            .unwrap_err();
        assert!(matches!(err, HabiError::Conflict(_)));
        assert!(err.to_string().contains(file));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read(&meta).unwrap(), original_meta);
    }
    h.skills()
        .save_document(
            &skill.summary.id,
            "Plan",
            &doc,
            skill.document_digest.as_deref(),
            None,
            Some("ignored"),
        )
        .unwrap();
    assert_eq!(std::fs::read(meta).unwrap(), original_meta);
}

#[test]
fn unmentioned_composition_cannot_travel_but_mentions_alone_can() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let h = open(home.path());
    std::fs::create_dir_all(home.path().join("person")).unwrap();
    let source = connect(&h, repo.path());
    let project_id = h.open_project(project.path()).unwrap().id;
    let skill = draft(
        &h,
        "birch-plan",
        "Review changes.\n",
        Some(vec![entry("cedar-review")]),
    );
    assert_eq!(skill.composition_state.unmentioned, ["cedar-review"]);
    let items = [ItemRef {
        source_id: LOCAL_SOURCE_ID.into(),
        item_id: skill.document.name.clone(),
    }];
    for error in [
        h.skills()
            .export_zip(&skill.summary.id, &home.path().join("out.zip"))
            .unwrap_err(),
        h.start_contribution(
            &source,
            ContributionOrigin::LocalSkill {
                skill_id: skill.summary.id.clone(),
            },
        )
        .unwrap_err(),
        h.plan_install(
            &project_id,
            &items,
            &[ClientId::ClaudeCode],
            false,
            &Decisions::default(),
        )
        .unwrap_err(),
        h.plan_install_machine(&items, &[ClientId::ClaudeCode], &Decisions::default())
            .unwrap_err(),
    ] {
        assert!(matches!(error, HabiError::InvalidInput(_)), "{error}");
        assert!(error.to_string().contains("instructions no longer mention"));
    }
    let mention = draft(&h, "elm-plan", "Use `cedar-review` skill.\n", None);
    h.skills()
        .export_zip(&mention.summary.id, &home.path().join("out.zip"))
        .unwrap();
}

#[test]
fn simultaneous_saves_serialize_and_one_reports_a_conflict() {
    let home = tempfile::tempdir().unwrap();
    let h = open(home.path());
    let skill = draft(&h, "birch-plan", "Start.\n", None);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let handles: Vec<_> = ["One.\n", "Two.\n"]
            .into_iter()
            .map(|body| {
                let (h, skill, barrier) = (&h, &skill, &barrier);
                scope.spawn(move || {
                    let mut doc = skill.document.clone();
                    doc.body = body.into();
                    barrier.wait();
                    h.skills().save_document(
                        &skill.summary.id,
                        "Plan",
                        &doc,
                        skill.document_digest.as_deref(),
                        Some(vec![]),
                        None,
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(HabiError::Conflict(_))))
                .count(),
            1
        );
    });
}

#[test]
fn cycles_incoming_optional_roles_and_unknown_project_are_honest() {
    let home = tempfile::tempdir().unwrap();
    let h = open(home.path());
    draft(
        &h,
        "cedar-review",
        "Use `birch-plan` skill and `elm-notes` skill.\n",
        Some(vec![entry("birch-plan")]),
    );
    let mut dependency = entry("cedar-review");
    dependency.roles = vec!["if-available".into()];
    let plan = draft(
        &h,
        "birch-plan",
        "Use `cedar-review` skill and `elm-notes` skill.\n",
        Some(vec![dependency]),
    );
    let dir = home.path().join("person/.claude/skills/elm-notes");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: elm-notes\ndescription: Record fictional notes.\n---\nRecord notes.\n",
    )
    .unwrap();
    let c = h
        .skill_composition(&plan.summary.id, Some("missing-project"))
        .unwrap();
    assert!(c.dependencies[0].optional);
    assert_eq!(c.cycles, [vec!["birch-plan", "cedar-review", "birch-plan"]]);
    assert!(c.incoming[0].explicit);
    assert_eq!(c.mentioned[0].name, "elm-notes");
    assert!(
        c.dependencies[0]
            .availability
            .iter()
            .all(|a| a.state == AvailabilityState::Unknown)
    );
    let shelf = h.skill_shelf().unwrap();
    assert!(
        shelf
            .iter()
            .any(|r| r.origin == ShelfOrigin::Machine && r.name == "elm-notes")
    );
}

#[test]
fn metadata_is_tolerant_and_composition_edits_keep_comments_and_other_keys() {
    let home = tempfile::tempdir().unwrap();
    let h = open(home.path());
    let skill = draft(&h, "birch-plan", "Use `cedar-review` skill.\n", None);
    let path = h.skills().file_path(&skill.summary.id, "SKILL.md").unwrap();
    let meta = path.parent().unwrap().join("habi.yaml");
    let original = "habi: 1\n# A fictional note.\nowner: forest-guild\ncomposes:\n  - skill: cedar-review # Keep this too.\n    roles: [after, future-role]\n  - false\n  - skill: 42\n  - unknown: true\n";
    std::fs::write(&meta, original).unwrap();
    let skill = h.skills().get(&skill.summary.id).unwrap();
    assert_eq!(skill.summary.errors, 0);
    assert_eq!(skill.composes.len(), 1);
    assert_eq!(skill.composes[0].roles, ["after", "future-role"]);
    assert_eq!(std::fs::read_to_string(&meta).unwrap(), original);
    let saved = h
        .skills()
        .save_document(
            &skill.summary.id,
            "Plan",
            &skill.document,
            skill.document_digest.as_deref(),
            Some(vec![]),
            skill.metadata_digest.as_deref(),
        )
        .unwrap();
    let text = saved.metadata_text.unwrap();
    assert!(text.contains("# A fictional note."));
    assert!(text.contains("# Keep this too."));
    assert!(text.contains("owner: forest-guild"));
    assert!(!text.contains("composes:"));
    std::fs::write(&meta, "habi: 1\ncomposes: unknown\n").unwrap();
    assert!(
        h.skills()
            .get(&skill.summary.id)
            .unwrap()
            .composes
            .is_empty()
    );
}

#[test]
fn unchanged_composition_preserves_bytes_and_empty_composition_removes_bare_sidecar() {
    let home = tempfile::tempdir().unwrap();
    let h = open(home.path());
    let skill = draft(
        &h,
        "birch-plan",
        "Use `cedar-review` skill.\n",
        Some(vec![entry("cedar-review")]),
    );
    let meta = h
        .skills()
        .file_path(&skill.summary.id, "habi.yaml")
        .unwrap();
    let original = std::fs::read(&meta).unwrap();
    let saved = h
        .skills()
        .save_document(
            &skill.summary.id,
            "Plan",
            &skill.document,
            skill.document_digest.as_deref(),
            Some(skill.composes.clone()),
            skill.metadata_digest.as_deref(),
        )
        .unwrap();
    assert_eq!(std::fs::read(&meta).unwrap(), original);
    h.skills()
        .save_document(
            &skill.summary.id,
            "Plan",
            &saved.document,
            saved.document_digest.as_deref(),
            Some(vec![]),
            saved.metadata_digest.as_deref(),
        )
        .unwrap();
    assert!(!meta.exists());
}

#[test]
fn shelf_counts_copies_and_availability_names_only_places_that_were_checked() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let h = open(home.path());
    let machine = home.path().join("person/.claude/skills/cedar-review");
    let project_copy = project.path().join(".claude/skills/cedar-review");
    for dir in [&machine, &project_copy] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: cedar-review\ndescription: Review fictional changes.\n---\nCheck changes.\n").unwrap();
        std::fs::write(dir.join("habi.yaml"), "habi: 1\ntitle: Cedar checks\n").unwrap();
    }
    let known = h.open_project(project.path()).unwrap();
    let plan = draft(
        &h,
        "birch-plan",
        "Use `cedar-review` skill.\n",
        Some(vec![entry("cedar-review")]),
    );
    let dir = h
        .skills()
        .file_path(&plan.summary.id, "SKILL.md")
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::create_dir(dir.join("examples")).unwrap();
    std::fs::write(dir.join("examples/plan.txt"), "abcd").unwrap();
    std::fs::create_dir(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets/picture.bin"), [0, 159, 146, 150]).unwrap();
    let shelf = h.skill_shelf().unwrap();
    let copies: Vec<_> = shelf.iter().filter(|r| r.name == "cedar-review").collect();
    assert_eq!(copies.len(), 2);
    assert!(
        copies
            .iter()
            .all(|r| r.title == "Cedar checks" && r.duplicates == 1 && r.same_content == 1)
    );
    let composition = h
        .skill_composition(&plan.summary.id, Some(&known.id))
        .unwrap();
    let claude = composition.dependencies[0]
        .availability
        .iter()
        .find(|a| a.client == ClientId::ClaudeCode)
        .unwrap();
    assert_eq!(claude.state, AvailabilityState::Found);
    assert_eq!(claude.place.as_deref(), Some("this machine"));
    let example = composition
        .context
        .files
        .iter()
        .find(|f| f.path == "examples/plan.txt")
        .unwrap();
    assert_eq!(example.kind, "example");
    assert_eq!(example.tokens, Some(1));
    assert_eq!(
        composition
            .context
            .files
            .iter()
            .find(|f| f.path == "assets/picture.bin")
            .unwrap()
            .tokens,
        None
    );
    std::fs::remove_dir_all(machine).unwrap();
    let composition = h
        .skill_composition(&plan.summary.id, Some(&known.id))
        .unwrap();
    let claude = composition.dependencies[0]
        .availability
        .iter()
        .find(|a| a.client == ClientId::ClaudeCode)
        .unwrap();
    assert_eq!(claude.state, AvailabilityState::Found);
    assert_eq!(claude.place.as_deref(), Some(known.name.as_str()));
    let elsewhere = h.skill_composition(&plan.summary.id, None).unwrap();
    assert!(
        elsewhere.dependencies[0]
            .availability
            .iter()
            .all(|a| a.state == AvailabilityState::NotFound)
    );
}
