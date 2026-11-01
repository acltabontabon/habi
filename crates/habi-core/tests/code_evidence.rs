//! Evidence from source code, from a real inspection through to what a rule
//! says: `code` conditions, three-valued absence, and where a declared
//! dependency is used.

use habi_core::cancel::CancelToken;
use habi_core::inspect::code::CodeLimits;
use habi_core::inspect::model::{CodeKind, CodeLanguage, CoverageStatus, ProjectInspection};
use habi_core::inspect::{WalkOptions, inspect};
use habi_core::matching::condition::Condition;
use habi_core::matching::eval::{EvalNode, Tri, View, evaluate};
use habi_core::matching::{Applicability, Scope, assess};
use serde_json::json;
use std::path::Path;

fn write(root: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text).unwrap();
    }
}

fn inspected(files: &[(&str, &str)]) -> (tempfile::TempDir, ProjectInspection) {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), files);
    let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
    (dir, i)
}

fn rule(value: serde_json::Value) -> Condition {
    Condition::parse(&value).unwrap()
}

fn in_repository(i: &ProjectInspection, value: serde_json::Value) -> EvalNode {
    evaluate(&rule(value), &View::repository(i, &[]))
}

fn in_module(i: &ProjectInspection, module: &str, value: serde_json::Value) -> EvalNode {
    evaluate(&rule(value), &View::module(i, module, &[]))
}

const POM: &str = "<project><modelVersion>4.0.0</modelVersion>\
    <groupId>a</groupId><artifactId>svc</artifactId><version>1</version>\
    <dependencies>\
    <dependency><groupId>org.jooq</groupId><artifactId>jooq</artifactId><version>3.19.0</version></dependency>\
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId><version>3.3.0</version></dependency>\
    <dependency><groupId>com.example.unused</groupId><artifactId>unused</artifactId><version>1.0</version></dependency>\
    </dependencies></project>";

const SERVICE: &str = "package a;\n\
    import org.jooq.DSLContext;\n\
    import org.springframework.boot.SpringApplication;\n\
    @Transactional\n\
    class Service {}\n";

#[test]
fn a_rule_on_an_import_holds_with_its_file_and_line() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_repository(&i, json!({"code": {"import": "org.jooq"}}));
    assert_eq!(n.outcome, Tri::True, "{}", n.reason);
    assert_eq!(
        n.location.as_deref(),
        Some("src/main/java/a/Service.java:2")
    );
    assert_eq!(n.reason, "imported in src/main/java/a/Service.java:2");
    assert_eq!(n.code[0].excerpt.as_deref(), Some("org.jooq.DSLContext"));
    assert_eq!(n.summary, "imports org.jooq");
}

#[test]
fn a_rule_on_an_annotation_holds_and_a_missing_one_is_false() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_repository(&i, json!({"code": {"annotation": "@Transactional"}}));
    assert_eq!(n.outcome, Tri::True, "{}", n.reason);
    assert_eq!(
        n.location.as_deref(),
        Some("src/main/java/a/Service.java:4")
    );

    let n = in_repository(&i, json!({"code": {"annotation": "Scheduled"}}));
    assert_eq!(n.outcome, Tri::False, "{}", n.reason);
    assert!(n.reason.contains("Java"), "{}", n.reason);

    let n = in_repository(&i, json!({"not": {"code": {"annotation": "Scheduled"}}}));
    assert_eq!(n.outcome, Tri::True);
}

#[test]
fn a_language_the_project_lacks_is_said_plainly() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_repository(
        &i,
        json!({"code": {"import": "org.jooq", "language": "kotlin"}}),
    );
    assert_eq!(n.outcome, Tri::False);
    assert_eq!(n.reason, "this repository has no Kotlin source");
}

#[test]
fn a_module_only_answers_for_its_own_source() {
    let (_d, i) = inspected(&[
        (
            "api/package.json",
            r#"{"name":"api","dependencies":{"express":"4.0.0"}}"#,
        ),
        ("api/src/index.js", "const e = require('express');\n"),
        (
            "web/package.json",
            r#"{"name":"web","dependencies":{"react":"19.0.0"}}"#,
        ),
        ("web/src/App.tsx", "import { useState } from 'react';\n"),
    ]);
    let express = json!({"code": {"import": "express"}});
    assert_eq!(in_module(&i, "api", express.clone()).outcome, Tri::True);
    assert_eq!(in_module(&i, "web", express.clone()).outcome, Tri::False);
    assert_eq!(in_repository(&i, express).outcome, Tri::True);
}

#[test]
fn absence_is_unknown_when_a_limit_stopped_the_reading() {
    let dir = tempfile::tempdir().unwrap();
    let big = format!("import a.B;\n{}", "// padding\n".repeat(2000));
    write(
        dir.path(),
        &[("pom.xml", POM), ("src/main/java/Big.java", &big)],
    );
    let options = WalkOptions {
        code: CodeLimits {
            file_bytes: 1024,
            ..Default::default()
        },
        ..Default::default()
    };
    let i = inspect(dir.path(), &options, &CancelToken::new()).unwrap();
    assert!(i.coverage.iter().any(|c| c.area == "code"
        && c.status == CoverageStatus::Partial
        && c.notes.iter().any(|n| n.contains("not read"))));

    let n = in_repository(&i, json!({"code": {"import": "a.B"}}));
    assert_eq!(n.outcome, Tri::Unknown, "{}", n.reason);
    assert!(n.reason.contains("not all source was read"), "{}", n.reason);

    // "Not present" is never concluded from what was not read.
    let n = in_repository(&i, json!({"not": {"code": {"import": "a.B"}}}));
    assert_eq!(n.outcome, Tri::Unknown);
}

#[test]
fn a_rule_for_any_language_is_unknown_beside_source_habi_cannot_read() {
    let (_d, i) = inspected(&[
        ("Service.java", "import a.B;\n"),
        ("Other.scala", "import x.Y\n"),
    ]);
    let any = in_repository(&i, json!({"code": {"import": "x.Y"}}));
    assert_eq!(any.outcome, Tri::Unknown, "{}", any.reason);
    assert!(any.reason.contains("Scala"), "{}", any.reason);
    let java = in_repository(&i, json!({"code": {"import": "x.Y", "language": "java"}}));
    assert_eq!(java.outcome, Tri::False, "{}", java.reason);
    let found = in_repository(&i, json!({"code": {"import": "a.B"}}));
    assert_eq!(found.outcome, Tri::True);
}

#[test]
fn a_declared_dependency_says_where_its_code_uses_it() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_module(&i, ".", json!({"dependency": "org.jooq:jooq"}));
    assert_eq!(n.outcome, Tri::True);
    assert!(
        n.reason
            .contains("imported in src/main/java/a/Service.java:2"),
        "{}",
        n.reason
    );
    assert_eq!(n.code[0].line, Some(2));
}

#[test]
fn a_tag_says_where_the_code_uses_what_it_rests_on() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_module(&i, ".", json!({"tag": "framework:spring-boot"}));
    assert_eq!(n.outcome, Tri::True, "{}", n.reason);
    assert!(
        n.reason
            .contains("imported in src/main/java/a/Service.java:3"),
        "{}",
        n.reason
    );
    assert_eq!(
        n.code[0].excerpt.as_deref(),
        Some("org.springframework.boot.SpringApplication")
    );
}

const TESTED_POM: &str = "<project><modelVersion>4.0.0</modelVersion>\
    <groupId>a</groupId><artifactId>svc</artifactId><version>1</version>\
    <dependencies>\
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.3.0</version></dependency>\
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><version>3.3.0</version><scope>test</scope></dependency>\
    </dependencies></project>";

const APP: &str = "package a;\nimport org.springframework.boot.SpringApplication;\nclass App {}\n";

/// Found running the app: JUnit, reached through a Spring Boot starter, was
/// "used in" a file importing only Spring Boot. A citation is a claim.
#[test]
fn a_tag_never_cites_another_technologys_import_from_the_same_group() {
    let (_d, i) = inspected(&[("pom.xml", TESTED_POM), ("src/main/java/a/App.java", APP)]);
    let junit = in_module(&i, ".", json!({"tag": "test:junit"}));
    assert_eq!(junit.outcome, Tri::True, "{}", junit.reason);
    assert!(junit.code.is_empty(), "{:?}", junit.code);
    assert!(!junit.reason.contains("imported"), "{}", junit.reason);
    let boot = in_module(&i, ".", json!({"tag": "framework:spring-boot"}));
    assert_eq!(boot.code[0].file, "src/main/java/a/App.java");

    // And with JUnit really imported, it cites that, not the first Spring file.
    let test = "package a;\nimport org.junit.jupiter.api.Test;\nclass AppTest {}\n";
    let (_d, i) = inspected(&[
        ("pom.xml", TESTED_POM),
        ("src/main/java/a/App.java", APP),
        ("src/test/java/a/AppTest.java", test),
    ]);
    let junit = in_module(&i, ".", json!({"tag": "test:junit"}));
    assert_eq!(junit.code[0].file, "src/test/java/a/AppTest.java");
    assert_eq!(
        junit.code[0].excerpt.as_deref(),
        Some("org.junit.jupiter.api.Test")
    );
}

#[test]
fn a_dependency_never_cites_another_artifacts_import_from_the_same_group() {
    let (_d, i) = inspected(&[("pom.xml", TESTED_POM), ("src/main/java/a/App.java", APP)]);
    let n = in_module(
        &i,
        ".",
        json!({"dependency": "org.springframework.boot:spring-boot-starter-test"}),
    );
    assert_eq!(n.outcome, Tri::True);
    assert!(n.code.is_empty(), "{:?}", n.code);
}

#[test]
fn a_tag_from_a_named_package_cites_it_outside_the_jvm() {
    let (_d, i) = inspected(&[
        (
            "package.json",
            r#"{"name":"web","dependencies":{"react":"19.0.0"}}"#,
        ),
        ("src/App.tsx", "import { useState } from 'react';\n"),
    ]);
    let n = in_module(&i, ".", json!({"tag": "framework:react"}));
    assert_eq!(n.outcome, Tri::True, "{}", n.reason);
    assert_eq!(n.code[0].file, "src/App.tsx");
}

#[test]
fn the_one_line_reason_says_where_it_is_declared_and_used() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let declared = rule(json!({"dependency": "org.jooq:jooq"}));
    let result = assess(Some(&declared), None, Scope::Module, &i, &[]);
    assert!(
        result.reason.contains("(pom.xml") && result.reason.contains("used in Service.java:2"),
        "{}",
        result.reason
    );
    let unused = rule(json!({"dependency": "com.example.unused:unused"}));
    let result = assess(Some(&unused), None, Scope::Module, &i, &[]);
    assert!(!result.reason.contains("used in"), "{}", result.reason);
    let written = rule(json!({"code": {"import": "org.jooq"}}));
    let result = assess(Some(&written), None, Scope::Module, &i, &[]);
    assert_eq!(result.reason, "Imports org.jooq (Service.java:2)");
}

#[test]
fn no_import_changes_nothing_about_a_declared_dependency() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let n = in_module(&i, ".", json!({"dependency": "com.example.unused:unused"}));
    assert_eq!(n.outcome, Tri::True);
    assert!(!n.reason.contains("imported"), "{}", n.reason);
    assert!(n.code.is_empty());
}

#[test]
fn a_rule_with_a_code_condition_applies_through_assessment() {
    let (_d, i) = inspected(&[("pom.xml", POM), ("src/main/java/a/Service.java", SERVICE)]);
    let applies = rule(json!({"all": [
        {"tag": "lang:java"},
        {"code": {"import": "org.jooq"}}
    ]}));
    let result = assess(Some(&applies), None, Scope::Module, &i, &[]);
    assert_eq!(
        result.applicability,
        Applicability::Applies,
        "{}",
        result.reason
    );

    let excluded = rule(json!({"code": {"annotation": "Transactional"}}));
    let result = assess(Some(&applies), Some(&excluded), Scope::Module, &i, &[]);
    assert_eq!(
        result.applicability,
        Applicability::DoesNotApply,
        "{}",
        result.reason
    );
}

#[test]
fn nothing_but_names_and_places_comes_out_of_the_source() {
    let (_d, i) = inspected(&[(
        "src/a.py",
        "import requests\nPASSWORD = 'hunter2'\nimport os # token=abc123\n",
    )]);
    let n = in_repository(&i, json!({"code": {"import": "requests"}}));
    let shown = serde_json::to_string(&n).unwrap();
    let inspection = serde_json::to_string(&i).unwrap();
    for text in [&shown, &inspection] {
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("abc123"));
    }
    assert_eq!(i.scan.source_files_read, 1);
}

#[test]
fn every_condition_kind_round_trips_through_the_schema_form() {
    let c = rule(json!({"code": {"import": "react", "language": "typescript"}}));
    let text = serde_json::to_string(&c).unwrap();
    assert_eq!(serde_json::from_str::<Condition>(&text).unwrap(), c);
    assert!(matches!(
        c,
        Condition::Code {
            kind: CodeKind::Import,
            language: Some(CodeLanguage::Typescript),
            ..
        }
    ));
}
