//! A rule read from a skill's own description (`matching::described`) can
//! speak for the skill, never against it, and every count says when a fit
//! rests on it rather than on the author's or the catalog's rule.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::matching::Applicability;
use habi_core::recommend::{Basis, Group};
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::fs;
use std::path::Path;

/// A skill with no `habi.yaml`: only its own words say what it is for.
fn skill(library: &Path, name: &str, description: &str) {
    let folder = library.join("skills").join(name);
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nSteps.\n"),
    )
    .unwrap();
}

#[test]
fn a_described_rule_promotes_a_skill_but_never_demotes_it() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    fs::write(
        library.path().join("habi-library.yaml"),
        "habi: 1\nname: Words (example)\nowner: Example\ndescription: Skills with no rules of their own.\nskills_root: skills\n",
    )
    .unwrap();
    skill(
        library.path(),
        "spring-config-review",
        "Review Spring Boot configuration for safe defaults. Use when application properties change.",
    );
    skill(
        library.path(),
        "django-admin-review",
        "Review Django admin customisations for security. Use when admin.py changes.",
    );
    skill(
        library.path(),
        "incident-timeline",
        "Turn an incident chat log into a blameless timeline.",
    );
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Words".into(),
            location: library.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();

    // A Spring Boot service, with no Python anywhere.
    let repo = tempfile::tempdir().unwrap();
    copy_tree(&fixture("repos/billing-service"), repo.path());
    let project = habi.open_project(repo.path()).unwrap();
    let overview = habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let rec = |id: &str| {
        overview
            .recommendations
            .iter()
            .find(|r| r.item.id == id)
            .unwrap_or_else(|| panic!("{id} is listed"))
    };

    // What the description names is here: the skill fits, as Habi's reading.
    let spring = rec("spring-config-review");
    assert_eq!(spring.basis, Basis::Described);
    assert_eq!(spring.applicability.applicability, Applicability::Applies);
    assert_eq!(spring.group, Group::Relevant);
    assert!(
        spring.applicability.reason.contains("pom.xml"),
        "the evidence is the project's, not the description: {}",
        spring.applicability.reason
    );

    // What the description names is absent: the skill stays available, as it
    // was before Habi read anything, and the reason says what was looked for.
    let django = rec("django-admin-review");
    assert_eq!(django.basis, Basis::Described);
    assert_eq!(
        django.applicability.applicability,
        Applicability::Undeclared,
        "a reading never rules a skill out"
    );
    assert_eq!(django.group, Group::Available);
    assert!(django.applicability.modules.is_empty());
    assert!(
        django.applicability.reason.contains("Django")
            && django.applicability.reason.contains("did not find"),
        "{}",
        django.applicability.reason
    );
    assert!(
        !overview
            .recommendations
            .iter()
            .any(|r| r.basis == Basis::Described
                && matches!(
                    r.applicability.applicability,
                    Applicability::DoesNotApply | Applicability::NeedsInformation
                )),
        "a described rule never lands a skill under Does not apply or Needs information"
    );

    // Words naming nothing Habi detects: no rule was read at all.
    let plain = rec("incident-timeline");
    assert_eq!(plain.basis, Basis::Declared);
    assert_eq!(plain.applicability.applicability, Applicability::Undeclared);
    assert_eq!(plain.group, Group::Available);

    // The remembered counts keep a described fit apart from a declared one.
    let summary = habi
        .project(&project.id)
        .unwrap()
        .summary
        .expect("the overview remembers a summary");
    assert_eq!((summary.fits, summary.described), (0, 1));
    assert_eq!(summary.sources, vec![source.id.clone()]);
    let tally = summary
        .tally
        .iter()
        .find(|t| t.source_id == source.id)
        .expect("the library is tallied");
    assert_eq!((tally.fits, tally.described), (0, 1));
}
