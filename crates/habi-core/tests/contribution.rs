//! Preparing a contribution in isolation, with patch and branch output.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::{ContributionOrigin, ContributionState, DraftFileStatus};
use habi_core::install::plan::Decisions;
use habi_core::library::model::DiagnosticLevel;
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn contribution_is_prepared_in_isolation_and_published_as_a_branch() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    let main_before = git(lib.path(), &["rev-parse", "main"]);
    copy_tree(&fixture("repos/billing-service"), proj.path());
    git(proj.path(), &["init", "-q"]);
    git(proj.path(), &["add", "-A"]);
    git(proj.path(), &["commit", "-qm", "project"]);

    // Contributions need an identity; tests set it through the environment-independent cache config.
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let cache = habi.sources().cache_dir(&source.id);
    git(&cache, &["config", "user.name", "Dev Example"]);
    git(&cache, &["config", "user.email", "dev@example.invalid"]);

    let project = habi.open_project(proj.path()).unwrap();
    let plan = habi
        .plan_install(
            &project.id,
            &[ItemRef {
                source_id: source.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    habi.apply(&plan.id).unwrap();

    // A local improvement.
    let skill = proj
        .path()
        .join(".claude/skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&skill).unwrap();
    text.push_str("\n7. For PostgreSQL, create indexes CONCURRENTLY in a separate changeset.\n");
    std::fs::write(&skill, &text).unwrap();
    let project_branch = git(proj.path(), &["branch", "--show-current"]);
    let project_status = git(proj.path(), &["status", "--porcelain"]);

    let draft = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::ProjectSkill {
                project_id: project.id.clone(),
                path: ".claude/skills/liquibase-migration-review".into(),
            },
        )
        .unwrap();
    assert_eq!(draft.item_path, "skills/liquibase-migration-review");
    let changed: Vec<(&str, DraftFileStatus)> = draft
        .files
        .iter()
        .filter(|f| f.status != DraftFileStatus::Unchanged)
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    assert_eq!(
        changed,
        vec![(
            "skills/liquibase-migration-review/SKILL.md",
            DraftFileStatus::Modified
        )]
    );
    assert!(
        draft.suggested_tags.contains(&"db:liquibase".to_string()),
        "{:?}",
        draft.suggested_tags
    );
    // Nested conditions are richer than the form; they are kept as written.
    assert!(!draft.form.conditions_editable);
    // The installed copy continues the library item: no "replaces" warning.
    assert!(
        !draft
            .validation
            .iter()
            .any(|d| d.message.contains("already exists")),
        "{:?}",
        draft.validation
    );

    // The author refines the metadata through the form.
    let mut form = draft.form.clone();
    form.examples.push(habi_core::contribute::ExampleEntry {
        title: "Index on a large table".into(),
        description: "Use CONCURRENTLY and a separate changeset.".into(),
    });
    let draft = habi
        .update_contribution(
            &draft.id,
            "Liquibase review: concurrent indexes",
            "Adds a PostgreSQL step.",
            &form,
        )
        .unwrap();
    assert!(
        draft
            .validation
            .iter()
            .all(|d| d.level != DiagnosticLevel::Error),
        "{:?}",
        draft.validation
    );
    let sidecar = draft
        .files
        .iter()
        .find(|f| f.path.ends_with("habi.yaml"))
        .unwrap();
    assert_eq!(sidecar.status, DraftFileStatus::Modified);

    let committed = habi
        .commit_contribution(&draft.id, &CancelToken::new())
        .unwrap();
    assert_eq!(committed.state, ContributionState::Committed);
    let commit = committed.commit_id.clone().unwrap();

    // Patch export.
    let patch = habi
        .contributions()
        .export_patch(&draft.id, out.path(), &CancelToken::new())
        .unwrap();
    let patch_text = std::fs::read_to_string(&patch).unwrap();
    assert!(patch_text.starts_with(&format!("From {commit}")));
    assert!(patch_text.contains("CONCURRENTLY"));
    assert!(patch_text.contains("Subject: [PATCH] Liquibase review: concurrent indexes"));

    // A hook in the library repository must not run when publishing.
    let marker = out.path().join("hook-ran");
    for hook in [
        "pre-receive",
        "post-receive",
        "update",
        "reference-transaction",
        "post-checkout",
    ] {
        let path = lib.path().join(".git/hooks").join(hook);
        std::fs::write(&path, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    // Publishing creates a contribution branch; the tracked branch is untouched.
    let outcome = habi
        .publish_contribution(&draft.id, false, &CancelToken::new())
        .unwrap();
    assert!(
        outcome
            .branch
            .starts_with("habi/contrib/liquibase-migration-review-")
    );
    assert_eq!(git(lib.path(), &["rev-parse", &outcome.branch]), commit);
    assert_eq!(git(lib.path(), &["rev-parse", "main"]), main_before);
    assert!(!marker.exists(), "no hook of the library repository ran");

    // The developer's project checkout was never touched by the contribution.
    assert_eq!(
        git(proj.path(), &["branch", "--show-current"]),
        project_branch
    );
    assert_eq!(git(proj.path(), &["status", "--porcelain"]), project_status);
}

#[test]
fn secrets_block_a_contribution() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    let skill = proj.path().join(".claude/skills/deploy-notes");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: deploy-notes\ndescription: How we deploy.\n---\nUse key AKIAABCDEFGHIJKLMNOP for the bucket.\n").unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let project = habi.open_project(proj.path()).unwrap();
    let draft = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::ProjectSkill {
                project_id: project.id,
                path: ".claude/skills/deploy-notes".into(),
            },
        )
        .unwrap();
    assert_eq!(draft.item_path, "skills/deploy-notes");
    assert!(
        draft
            .validation
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error && d.message.contains("AWS"))
    );
    assert!(
        habi.commit_contribution(&draft.id, &CancelToken::new())
            .is_err()
    );
}

#[test]
fn rehearsal_summarizes_where_the_rules_apply_by_project_name() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let billing = tempfile::tempdir().unwrap();
    let storefront = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    copy_tree(&fixture("repos/billing-service"), billing.path());
    copy_tree(&fixture("repos/storefront-web"), storefront.path());

    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let b = habi.open_project(billing.path()).unwrap();
    habi.open_project(storefront.path()).unwrap();

    let c = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LibraryItem {
                item_id: "liquibase-migration-review".into(),
            },
        )
        .unwrap();
    let r = habi
        .contribution_rehearsal(&c.id, &CancelToken::new())
        .unwrap();
    assert_eq!(r.projects, 2);
    assert!(
        r.text.contains(&format!("- Applies: {}", b.name)),
        "{}",
        r.text
    );
    assert!(r.text.contains("- Does not apply: 1 project"), "{}", r.text);
    assert!(r.text.contains("the rules only"), "{}", r.text);
    // Names only: no absolute paths leave the machine this way.
    assert!(
        !r.text
            .contains(&billing.path().to_string_lossy().to_string()),
        "{}",
        r.text
    );
}

/// A Habi home with the example library as a Git repository on this
/// machine, fetched, and an identity for contribution commits.
struct Setup {
    _dirs: Vec<tempfile::TempDir>,
    lib: std::path::PathBuf,
    habi: Habi,
    source: String,
}

fn setup() -> Setup {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let cache = habi.sources().cache_dir(&source.id);
    git(&cache, &["config", "user.name", "Dev Example"]);
    git(&cache, &["config", "user.email", "dev@example.invalid"]);
    Setup {
        lib: lib.path().to_path_buf(),
        _dirs: vec![home, lib],
        habi,
        source: source.id,
    }
}

impl Setup {
    fn cache(&self) -> std::path::PathBuf {
        self.habi.sources().cache_dir(&self.source)
    }

    fn staging(&self, id: &str) -> std::path::PathBuf {
        self.habi.paths.contributions().join(id).join("files")
    }

    fn library_item(&self, item: &str) -> habi_core::contribute::Contribution {
        self.habi
            .start_contribution(
                &self.source,
                ContributionOrigin::LibraryItem {
                    item_id: item.into(),
                },
            )
            .unwrap()
    }
}

fn append(path: &Path, text: &str) {
    let mut s = std::fs::read_to_string(path).unwrap();
    s.push_str(text);
    std::fs::write(path, s).unwrap();
}

#[test]
fn patches_hold_every_commit_of_the_contribution_and_any_size() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("jpa-entity-review");
    // A library-item contribution is edited in its staging folder, which the
    // contribution names.
    let staging = s.staging(&c.id);
    assert!(staging.join("SKILL.md").is_file());
    // Shown with the platform's separators; compare path components.
    assert!(
        std::path::Path::new(&c.staging_path).ends_with(
            std::path::Path::new("contributions")
                .join(&c.id)
                .join("files")
        ),
        "{}",
        c.staging_path
    );

    // Larger than the 64 KiB Git output Habi reads by default.
    let big: String = (0..12_000)
        .map(|i| format!("Reference line {i}: keep entities small.\n"))
        .collect();
    std::fs::create_dir_all(staging.join("reference")).unwrap();
    std::fs::write(staging.join("reference/big.md"), &big).unwrap();
    let first = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let first_commit = first.commit_id.clone().unwrap();
    let out = tempfile::tempdir().unwrap();
    let patch = s
        .habi
        .contributions()
        .export_patch(&c.id, out.path(), &cancel)
        .unwrap();
    let text = std::fs::read_to_string(&patch).unwrap();
    assert!(text.len() > big.len(), "{} bytes", text.len());
    assert!(text.starts_with(&format!("From {first_commit}")));
    assert!(text.contains("+Reference line 11999: keep entities small."));

    // Send it, then revise: an unchanged revision is refused.
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();
    let r = s.habi.revise_contribution(&c.id).unwrap();
    assert_eq!(r.state, ContributionState::Draft);
    assert_eq!(r.revision, 1);
    assert!(r.revising);
    let err = s.habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert!(
        err.to_string()
            .contains("Nothing changed since the version you sent"),
        "{err}"
    );

    // Backing out returns to the sent version.
    std::fs::write(staging.join("SKILL.md"), "scratch").unwrap();
    let back = s.habi.cancel_contribution_revision(&c.id).unwrap();
    assert_eq!(back.state, ContributionState::Published);
    assert_eq!(back.commit_id.as_deref(), Some(first_commit.as_str()));
    assert_eq!(back.revision, 0);
    assert!(!back.revising);
    assert_ne!(
        std::fs::read_to_string(staging.join("SKILL.md")).unwrap(),
        "scratch",
        "the staged files are the sent ones again"
    );
    assert_eq!(
        std::fs::read_to_string(staging.join("reference/big.md")).unwrap(),
        big
    );
    assert!(s.habi.cancel_contribution_revision(&c.id).is_err());

    // A real revision: the patch holds both commits and applies to the
    // tracked branch.
    s.habi.revise_contribution(&c.id).unwrap();
    append(&staging.join("SKILL.md"), "\nCheck equals and hashCode.\n");
    let second = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let second_commit = second.commit_id.clone().unwrap();
    let message = git(&s.cache(), &["log", "-1", "--format=%B", &second_commit]);
    assert!(message.contains("Revision 1 after review."), "{message}");
    let patch = s
        .habi
        .contributions()
        .export_patch(&c.id, out.path(), &cancel)
        .unwrap();
    let text = std::fs::read_to_string(&patch).unwrap();
    assert!(text.contains("[PATCH 1/2]") && text.contains("[PATCH 2/2]"));
    let clone = tempfile::tempdir().unwrap();
    // Byte-for-byte checkout, whatever the machine's core.autocrlf says.
    git(
        clone.path(),
        &[
            "clone",
            "-q",
            "--config",
            "core.autocrlf=false",
            s.lib.to_str().unwrap(),
            "work",
        ],
    );
    let work = clone.path().join("work");
    git(&work, &["am", "-q", patch.to_str().unwrap()]);
    let applied = std::fs::read_to_string(work.join("skills/jpa-entity-review/SKILL.md")).unwrap();
    assert!(applied.contains("Check equals and hashCode."));
    assert_eq!(
        std::fs::read_to_string(work.join("skills/jpa-entity-review/reference/big.md")).unwrap(),
        big
    );
}

#[test]
fn a_revision_takes_the_skill_as_it_is_when_prepared() {
    let s = setup();
    let cancel = CancelToken::new();
    let proj = tempfile::tempdir().unwrap();
    let skill = proj.path().join(".claude/skills/deploy-notes");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: deploy-notes\ndescription: How we deploy. Use when shipping a service.\n---\n1. Tag the release.\n",
    )
    .unwrap();
    let project = s.habi.open_project(proj.path()).unwrap();
    let c = s
        .habi
        .start_contribution(
            &s.source,
            ContributionOrigin::ProjectSkill {
                project_id: project.id.clone(),
                path: ".claude/skills/deploy-notes".into(),
            },
        )
        .unwrap();
    s.habi.commit_contribution(&c.id, &cancel).unwrap();

    // Revising a version that was never sent is not a revision "after review".
    let r = s.habi.revise_contribution(&c.id).unwrap();
    assert_eq!(r.revision, 0);
    // Revising what is already open for changes claims nothing new.
    let again = s.habi.revise_contribution(&c.id).unwrap();
    assert_eq!(again.revision, 0);
    assert_eq!(again.state, ContributionState::Draft);
    // Edited where it lives, after "Revise".
    append(&skill.join("SKILL.md"), "2. Announce it.\n");
    let prepared = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let commit = prepared.commit_id.clone().unwrap();
    let cache = s.cache();
    let shown = git(
        &cache,
        &["show", &format!("{commit}:skills/deploy-notes/SKILL.md")],
    );
    assert!(shown.contains("2. Announce it."), "{shown}");
    let message = git(&cache, &["log", "-1", "--format=%B", &commit]);
    assert!(!message.contains("Revision"), "{message}");

    // After sending, an unchanged revision is refused; an edited one is not.
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();
    let r = s.habi.revise_contribution(&c.id).unwrap();
    assert_eq!(r.revision, 1);
    let err = s.habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert!(err.to_string().contains("Nothing changed"), "{err}");
    append(&skill.join("SKILL.md"), "3. Watch the dashboards.\n");
    let revised = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let message = git(
        &cache,
        &[
            "log",
            "-1",
            "--format=%B",
            revised.commit_id.as_deref().unwrap(),
        ],
    );
    assert!(message.contains("Revision 1 after review."), "{message}");
}

#[test]
fn a_discarded_contribution_cannot_be_sent() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("jpa-entity-review");
    append(&s.staging(&c.id).join("SKILL.md"), "\nMore.\n");
    let committed = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    s.habi.contributions().discard(&c.id).unwrap();
    let out = tempfile::tempdir().unwrap();
    for err in [
        s.habi
            .contributions()
            .export_patch(&c.id, out.path(), &cancel)
            .unwrap_err(),
        s.habi
            .publish_contribution(&c.id, false, &cancel)
            .map(|_| ())
            .unwrap_err(),
        s.habi
            .refresh_contribution_review(&c.id, &cancel)
            .map(|_| ())
            .unwrap_err(),
        s.habi
            .commit_contribution(&c.id, &cancel)
            .map(|_| ())
            .unwrap_err(),
    ] {
        assert!(err.to_string().contains("discarded"), "{err}");
    }
    let gone = s.habi.contributions().preview(&c.id).unwrap();
    assert_eq!(gone.state, ContributionState::Discarded);
    assert_eq!(gone.commit_id, None);
    assert!(git(&s.lib, &["branch", "--list", &committed.branch]).is_empty());
}

#[cfg(unix)]
#[test]
fn the_executable_bit_is_kept_even_where_the_staged_copy_loses_it() {
    use std::os::unix::fs::PermissionsExt;
    let s = setup();
    let cancel = CancelToken::new();
    // An executable script in the library.
    let script = s.lib.join("skills/jpa-entity-review/scripts/check.sh");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, "#!/bin/sh\necho ok\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(&s.lib, &["add", "-A"]);
    git(&s.lib, &["commit", "-qm", "script"]);
    s.habi.sources().refresh(&s.source, &cancel).unwrap();

    let c = s.library_item("jpa-entity-review");
    let staged = s.staging(&c.id).join("scripts/check.sh");
    // As on a file system without the bit (Windows).
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o644)).unwrap();
    append(&staged, "echo more\n");
    let committed = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let tree = git(
        &s.cache(),
        &[
            "ls-tree",
            committed.commit_id.as_deref().unwrap(),
            "skills/jpa-entity-review/scripts/check.sh",
        ],
    );
    assert!(tree.starts_with("100755 "), "{tree}");
}

#[test]
fn only_a_deleted_branch_lets_a_revision_rebuild_it() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("jpa-entity-review");
    let staging = s.staging(&c.id);
    append(&staging.join("SKILL.md"), "\nFirst.\n");
    s.habi.commit_contribution(&c.id, &cancel).unwrap();
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();

    // Merged and deleted on the remote: the revision recreates the branch.
    git(&s.lib, &["branch", "-D", &c.branch]);
    s.habi.revise_contribution(&c.id).unwrap();
    append(&staging.join("SKILL.md"), "Second.\n");
    let second = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();
    assert_eq!(
        git(&s.lib, &["rev-parse", &c.branch]),
        second.commit_id.clone().unwrap()
    );

    // The remote cannot be reached: Habi cannot tell whether someone else
    // pushed, so it stops instead of building on what it last sent.
    s.habi.revise_contribution(&c.id).unwrap();
    append(&staging.join("SKILL.md"), "Third.\n");
    let moved = s.lib.with_extension("moved");
    std::fs::rename(&s.lib, &moved).unwrap();
    let err = s.habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert!(err.to_info().code.starts_with("git"), "{err}");
    std::fs::rename(&moved, &s.lib).unwrap();
    let draft = s.habi.contributions().preview(&c.id).unwrap();
    assert_eq!(draft.state, ContributionState::Draft);
    s.habi.commit_contribution(&c.id, &cancel).unwrap();
}

#[test]
fn sharing_a_new_skill_under_an_existing_name_says_it_replaces_the_item() {
    let s = setup();
    let proj = tempfile::tempdir().unwrap();
    let skill = proj.path().join(".claude/skills/jpa-entity-review");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: jpa-entity-review\ndescription: Our own take on entities. Use when writing entities.\n---\nSomething else entirely.\n",
    )
    .unwrap();
    let project = s.habi.open_project(proj.path()).unwrap();
    let c = s
        .habi
        .start_contribution(
            &s.source,
            ContributionOrigin::ProjectSkill {
                project_id: project.id,
                path: ".claude/skills/jpa-entity-review".into(),
            },
        )
        .unwrap();
    assert_eq!(c.item_path, "skills/jpa-entity-review");
    assert!(
        c.validation.iter().any(|d| d.level == DiagnosticLevel::Warning
            && d.message.contains(
                "A library skill named `jpa-entity-review` already exists at skills/jpa-entity-review"
            )),
        "{:?}",
        c.validation
    );
}

#[test]
fn saving_an_unchanged_form_leaves_the_metadata_as_written() {
    let s = setup();
    let c = s.library_item("jpa-entity-review");
    let sidecar = s.staging(&c.id).join("habi.yaml");
    let before = std::fs::read_to_string(&sidecar).unwrap();
    let saved = s
        .habi
        .update_contribution(&c.id, "Share JPA entity review", "Why", &c.form)
        .unwrap();
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), before);
    assert!(
        saved
            .files
            .iter()
            .all(|f| !f.path.ends_with("habi.yaml") || f.status == DraftFileStatus::Unchanged)
    );

    // One field changed: `scope: module` and the key order stay.
    let mut form = c.form.clone();
    form.owner = "Data Guild".into();
    let saved = s
        .habi
        .update_contribution(&c.id, "Share JPA entity review", "Why", &form)
        .unwrap();
    let after = std::fs::read_to_string(&sidecar).unwrap();
    assert!(after.contains("scope: module"), "{after}");
    assert!(after.contains("owner: Data Guild"), "{after}");
    let file = saved
        .files
        .iter()
        .find(|f| f.path.ends_with("habi.yaml"))
        .unwrap();
    assert_eq!(file.status, DraftFileStatus::Modified);
    let keys = |t: &str| -> Vec<String> {
        t.lines()
            .filter(|l| !l.starts_with(' ') && !l.starts_with('#') && l.contains(':'))
            .map(|l| l.split(':').next().unwrap().to_string())
            .collect()
    };
    assert_eq!(keys(&after), keys(&before));
}

/// Files under the skill folder in a commit of Habi's cache.
fn tree_files(s: &Setup, commit: &str, folder: &str) -> Vec<String> {
    git(
        &s.cache(),
        &["ls-tree", "-r", "--name-only", commit, "--", folder],
    )
    .lines()
    .map(str::to_string)
    .collect()
}

#[test]
fn a_moved_file_is_a_rename_and_unchanged_files_follow_the_changes() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("api-contract-review");
    let staging = s.staging(&c.id);
    std::fs::create_dir_all(staging.join("docs")).unwrap();
    std::fs::rename(
        staging.join("references/breaking-changes.md"),
        staging.join("docs/breaking-changes.md"),
    )
    .unwrap();

    // Moved, but SKILL.md still links to the old place.
    let c = s.habi.contributions().preview(&c.id).unwrap();
    let errors: Vec<&str> = c
        .validation
        .iter()
        .filter(|d| d.level == DiagnosticLevel::Error)
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(
        errors,
        vec![
            "SKILL.md refers to references/breaking-changes.md, which this contribution renames to docs/breaking-changes.md. Update the reference."
        ]
    );

    let skill = staging.join("SKILL.md");
    let text = std::fs::read_to_string(&skill)
        .unwrap()
        .replace("references/breaking-changes.md", "docs/breaking-changes.md");
    std::fs::write(&skill, text).unwrap();
    let c = s.habi.contributions().preview(&c.id).unwrap();
    let files: Vec<(&str, DraftFileStatus, Option<&str>)> = c
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status, f.previous_path.as_deref()))
        .collect();
    assert_eq!(
        files,
        vec![
            (
                "skills/api-contract-review/SKILL.md",
                DraftFileStatus::Modified,
                None
            ),
            (
                "skills/api-contract-review/docs/breaking-changes.md",
                DraftFileStatus::Renamed,
                Some("skills/api-contract-review/references/breaking-changes.md")
            ),
            (
                "skills/api-contract-review/habi.yaml",
                DraftFileStatus::Unchanged,
                None
            ),
        ]
    );
    assert!(
        c.validation
            .iter()
            .all(|d| d.level != DiagnosticLevel::Error),
        "{:?}",
        c.validation
    );
    let committed = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    assert_eq!(
        tree_files(
            &s,
            committed.commit_id.as_deref().unwrap(),
            "skills/api-contract-review"
        ),
        vec![
            "skills/api-contract-review/SKILL.md",
            "skills/api-contract-review/docs/breaking-changes.md",
            "skills/api-contract-review/habi.yaml",
        ]
    );
}

#[test]
fn files_left_out_are_not_committed_and_keep_the_library_version() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("jpa-entity-review");
    let staging = s.staging(&c.id);
    append(&staging.join("SKILL.md"), "\nCheck cascade types.\n");
    std::fs::create_dir_all(staging.join("notes")).unwrap();
    std::fs::write(staging.join("notes/draft.md"), "Private scratch notes.\n").unwrap();
    std::fs::write(staging.join("examples.md"), "An example.\n").unwrap();
    std::fs::remove_file(staging.join("habi.yaml")).unwrap();

    let c = s
        .habi
        .select_contribution_files(
            &c.id,
            &[
                "skills/jpa-entity-review/notes/draft.md".into(),
                // A path in the skill folder works too.
                "habi.yaml".into(),
            ],
        )
        .unwrap();
    let included: Vec<(&str, DraftFileStatus, bool)> = c
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status, f.included))
        .collect();
    assert_eq!(
        included,
        vec![
            (
                "skills/jpa-entity-review/SKILL.md",
                DraftFileStatus::Modified,
                true
            ),
            (
                "skills/jpa-entity-review/examples.md",
                DraftFileStatus::Added,
                true
            ),
            (
                "skills/jpa-entity-review/habi.yaml",
                DraftFileStatus::Removed,
                false
            ),
            (
                "skills/jpa-entity-review/notes/draft.md",
                DraftFileStatus::Added,
                false
            ),
        ]
    );
    // The selection is checked against the package.
    let err = s
        .habi
        .select_contribution_files(&c.id, &["skills/jpa-entity-review/nope.md".into()])
        .unwrap_err();
    assert!(err.to_string().contains("not a file"), "{err}");

    let committed = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    let commit = committed.commit_id.clone().unwrap();
    assert_eq!(
        tree_files(&s, &commit, "skills/jpa-entity-review"),
        vec![
            "skills/jpa-entity-review/SKILL.md",
            "skills/jpa-entity-review/examples.md",
            "skills/jpa-entity-review/habi.yaml",
        ]
    );
    // The removal was left out: the library's metadata stays as it was.
    assert_eq!(
        git(
            &s.cache(),
            &[
                "rev-parse",
                &format!("{commit}:skills/jpa-entity-review/habi.yaml")
            ]
        ),
        git(
            &s.cache(),
            &[
                "rev-parse",
                &format!("{}:skills/jpa-entity-review/habi.yaml", c.base_commit)
            ]
        )
    );
    // The left-out file is still in the staging folder, not lost.
    assert!(staging.join("notes/draft.md").is_file());
    // The patch holds only what was included.
    let out = tempfile::tempdir().unwrap();
    let patch = s
        .habi
        .contributions()
        .export_patch(&c.id, out.path(), &cancel)
        .unwrap();
    let patch = std::fs::read_to_string(patch).unwrap();
    assert!(patch.contains("Check cascade types."));
    assert!(!patch.contains("Private scratch notes."));
    // Once prepared, the selection is fixed until Revise.
    assert!(
        s.habi
            .select_contribution_files(&c.id, &[])
            .unwrap_err()
            .to_string()
            .contains("Revise")
    );
}

#[test]
fn a_reference_to_a_left_out_or_deleted_file_blocks_preparing() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("liquibase-migration-review");
    let staging = s.staging(&c.id);
    let errors = |c: &habi_core::contribute::Contribution| -> Vec<(String, Option<String>)> {
        c.validation
            .iter()
            .filter(|d| d.level == DiagnosticLevel::Error)
            .map(|d| (d.message.clone(), d.path.clone()))
            .collect()
    };

    // Deleting a file SKILL.md links to.
    let checklist = std::fs::read(staging.join("references/checklist.md")).unwrap();
    std::fs::remove_file(staging.join("references/checklist.md")).unwrap();
    let c = s.habi.contributions().preview(&c.id).unwrap();
    assert_eq!(
        errors(&c),
        vec![(
            "SKILL.md refers to references/checklist.md, which this contribution deletes. Keep references/checklist.md, or remove the reference.".to_string(),
            Some("skills/liquibase-migration-review/SKILL.md".to_string())
        )]
    );
    let err = s.habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert!(err.to_string().contains("validation"), "{err}");
    // A validation problem is fixed in place; it is not a failed operation.
    assert!(
        s.habi
            .contributions()
            .preview(&c.id)
            .unwrap()
            .attention
            .is_none()
    );
    // Leaving the deletion out keeps the library's file: the reference is
    // fine (and, with nothing else changed, there is nothing to share).
    let c = s
        .habi
        .select_contribution_files(
            &c.id,
            &["skills/liquibase-migration-review/references/checklist.md".into()],
        )
        .unwrap();
    assert_eq!(
        errors(&c),
        vec![(
            "Every changed file is left out, so there is nothing to share. Include at least one."
                .to_string(),
            None
        )]
    );
    std::fs::write(staging.join("references/checklist.md"), checklist).unwrap();

    // A new script named in inline code, then left out.
    std::fs::create_dir_all(staging.join("scripts")).unwrap();
    std::fs::write(staging.join("scripts/verify.sh"), "#!/bin/sh\necho ok\n").unwrap();
    append(
        &staging.join("SKILL.md"),
        "\nRun `scripts/verify.sh` before reviewing.\n",
    );
    let c = s
        .habi
        .select_contribution_files(
            &c.id,
            &["skills/liquibase-migration-review/scripts/verify.sh".into()],
        )
        .unwrap();
    assert_eq!(
        errors(&c),
        vec![(
            "SKILL.md refers to scripts/verify.sh, which is left out of this contribution. Include scripts/verify.sh, or remove the reference.".to_string(),
            Some("skills/liquibase-migration-review/SKILL.md".to_string())
        )]
    );
    let c = s.habi.select_contribution_files(&c.id, &[]).unwrap();
    assert!(errors(&c).is_empty(), "{:?}", errors(&c));
    s.habi.commit_contribution(&c.id, &cancel).unwrap();
}

#[test]
fn retrying_never_creates_a_second_branch_or_commit() {
    let s = setup();
    let cancel = CancelToken::new();
    let c = s.library_item("jpa-entity-review");
    append(&s.staging(&c.id).join("SKILL.md"), "\nMore.\n");
    let first = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    // Preparing again returns the same commit on the same branch.
    let again = s.habi.commit_contribution(&c.id, &cancel).unwrap();
    assert_eq!(again.commit_id, first.commit_id);
    assert_eq!(again.state, ContributionState::Committed);

    // Sending fails: the library cannot be reached. Nothing is pushed and
    // the contribution says it needs attention.
    let moved = s.lib.with_extension("moved");
    std::fs::rename(&s.lib, &moved).unwrap();
    s.habi
        .publish_contribution(&c.id, false, &cancel)
        .unwrap_err();
    std::fs::rename(&moved, &s.lib).unwrap();
    let failed = s.habi.contributions().preview(&c.id).unwrap();
    assert_eq!(failed.state, ContributionState::Committed);
    let attention = failed.attention.expect("the failure is recorded");
    assert_eq!(attention.kind, habi_core::contribute::AttentionKind::Send);
    assert!(git(&s.lib, &["branch", "--list", "habi/contrib/*"]).is_empty());

    // Retrying succeeds and clears it; retrying once more changes nothing.
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();
    let sent = s.habi.contributions().preview(&c.id).unwrap();
    assert!(sent.attention.is_none());
    assert!(sent.published_at.is_some());
    s.habi.publish_contribution(&c.id, false, &cancel).unwrap();
    let branches: Vec<String> = git(&s.lib, &["branch", "--list", "habi/contrib/*"])
        .lines()
        .map(|l| l.trim_start_matches(['*', ' ']).to_string())
        .collect();
    assert_eq!(branches, vec![c.branch.clone()]);
    assert_eq!(
        git(&s.lib, &["rev-parse", &c.branch]),
        first.commit_id.unwrap()
    );
    assert_eq!(
        git(
            &s.lib,
            &["rev-list", "--count", &format!("main..{}", c.branch)]
        ),
        "1"
    );
}
