//! Real project shapes, end to end: what inspection establishes for each, what it
//! leaves alone, and that nothing secret in them reaches what it returns.

use habi_core::cancel::CancelToken;
use habi_core::inspect::model::{CoverageStatus, ProjectInspection};
use habi_core::inspect::{WalkOptions, inspect};
use std::collections::BTreeSet;

fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in files {
        let at = dir.path().join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, text).unwrap();
    }
    dir
}

fn inspected(files: &[(&str, &str)]) -> ProjectInspection {
    let dir = project(files);
    inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap()
}

fn tags(i: &ProjectInspection) -> BTreeSet<&str> {
    i.facts.iter().filter_map(|f| f.tag()).collect()
}

fn tags_of<'a>(i: &'a ProjectInspection, module: &str) -> BTreeSet<&'a str> {
    i.facts
        .iter()
        .filter(|f| f.module == module)
        .filter_map(|f| f.tag())
        .collect()
}

fn incidental(i: &ProjectInspection, tag: &str) -> bool {
    i.facts
        .iter()
        .find(|f| f.tag() == Some(tag))
        .unwrap_or_else(|| panic!("no {tag}"))
        .incidental
}

fn gradle_coverage(i: &ProjectInspection, module: &str) -> CoverageStatus {
    i.coverage
        .iter()
        .find(|c| c.module == module && c.area == "gradle")
        .unwrap()
        .status
}

const BOOT_POM: &str = r#"<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent><artifactId>svc</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency></dependencies></project>"#;

#[test]
fn a_terraform_and_helm_repository_is_seen() {
    let i = inspected(&[
        ("terraform/main.tf", "module \"vpc\" {}\n"),
        ("terraform/modules/vpc/main.tf", "resource \"x\" \"y\" {}\n"),
        ("terraform/.terraform.lock.hcl", "provider \"x\" {}\n"),
        ("terragrunt/prod/terragrunt.hcl", "include {}\n"),
        ("charts/api/Chart.yaml", "apiVersion: v2\nname: api\n"),
        (
            "charts/api/templates/deployment.yaml",
            "apiVersion: apps/v1\nkind: Deployment\n",
        ),
        ("k8s/base/kustomization.yaml", "resources: []\n"),
        ("ansible/playbook.yml", "- hosts: all\n"),
        ("build/Dockerfile", "FROM alpine\n"),
        ("scripts/lambda/handler.py", "def h(e, c): pass\n"),
    ]);
    let found = tags(&i);
    for tag in [
        "infra:terraform",
        "infra:terragrunt",
        "infra:helm",
        "infra:kubernetes",
        "infra:kustomize",
        "infra:ansible",
        "container:docker",
        "lang:hcl",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
    // One Lambda beside the infrastructure does not make this a Python project.
    assert!(incidental(&i, "lang:python"));
}

#[test]
fn a_kubernetes_repository_is_seen_from_its_manifests() {
    let i = inspected(&[(
        "deploy/app.yaml",
        "apiVersion: apps/v1\nkind: Deployment\nmetadata: {}\n",
    )]);
    assert!(tags(&i).contains("infra:kubernetes"));

    let i = inspected(&[("config/app.yaml", "name: app\nkind: thing\n")]);
    assert!(!tags(&i).contains("infra:kubernetes"));
}

#[test]
fn a_databricks_bundle_is_seen_without_any_manifest() {
    let i = inspected(&[
        ("databricks.yml", "bundle:\n  name: lake\n"),
        (
            "src/notebooks/ingest.py",
            "# Databricks notebook source\nspark.read.table('x')\n",
        ),
        ("src/notebooks/job.scala", "// Databricks notebook source\n"),
        ("src/notebooks/explore.ipynb", "{\"cells\":[]}\n"),
        ("scripts/deploy.sh", "#!/bin/bash\n"),
        (".databricks/bundle/dev/terraform/main.tf", "x\n"),
    ]);
    let found = tags(&i);
    for tag in [
        "data:databricks",
        "data:jupyter",
        "lang:python",
        "lang:scala",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
    // The bundle's own cache is not a Terraform project.
    assert!(!found.contains("infra:terraform"), "{found:?}");
    assert!(!incidental(&i, "lang:python"));
    assert!(incidental(&i, "lang:shell"));
}

#[test]
fn old_style_notebooks_are_seen_by_their_first_line_alone() {
    let i = inspected(&[("notebooks/a.py", "# Databricks notebook source\n")]);
    assert!(tags(&i).contains("data:databricks"));
    // The same words later in the file, or outside a notebook folder, do not count.
    let i = inspected(&[("notebooks/a.py", "x = 1\n# Databricks notebook source\n")]);
    assert!(!tags(&i).contains("data:databricks"));
    let i = inspected(&[("src/a.py", "# Databricks notebook source\n")]);
    assert!(!tags(&i).contains("data:databricks"));
}

#[test]
fn a_databricks_wheel_is_read_from_its_dependencies() {
    let i = inspected(&[(
        "pyproject.toml",
        "[project]\nname = \"w\"\ndependencies = [\"databricks-connect==15.4.0\", \"delta-spark\", \"mlflow\"]\n",
    )]);
    let found = tags(&i);
    for tag in ["data:databricks", "data:delta", "data:mlflow", "data:spark"] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
}

#[test]
fn a_bash_repository_is_a_shell_project_and_shell_in_a_service_is_not() {
    let i = inspected(&[
        ("bin/rollback.sh", "#!/bin/bash\n"),
        ("lib/common.bash", "log() { :; }\n"),
        ("test/deploy.bats", "@test 'x' { true; }\n"),
    ]);
    assert!(tags(&i).contains("test:bats"));
    assert!(!incidental(&i, "lang:shell"));

    let i = inspected(&[
        ("pom.xml", BOOT_POM),
        ("src/main/java/A.java", "class A {}\n"),
        ("scripts/release.sh", "#!/bin/bash\n"),
    ]);
    assert!(incidental(&i, "lang:shell"));
    assert!(!incidental(&i, "lang:java"));
}

#[test]
fn stray_files_are_incidental_and_a_real_second_language_is_not() {
    let mut files: Vec<(String, String)> = (0..40)
        .map(|n| {
            (
                format!("src/main/java/C{n}.java"),
                "class C {}\n".to_string(),
            )
        })
        .collect();
    files.push(("pom.xml".into(), BOOT_POM.into()));
    files.push(("scripts/one_off.py".into(), "print(1)\n".into()));
    files.push(("tools/dash.go".into(), "package main\n".into()));
    files.push(("src/main/resources/static/app.js".into(), "1;\n".into()));
    files.push(("analysis/report.py".into(), "print(1)\n".into()));
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let i = inspected(&borrowed);
    assert!(incidental(&i, "lang:python"));
    assert!(incidental(&i, "lang:go"));
    assert!(incidental(&i, "lang:javascript"));
    assert!(!incidental(&i, "lang:java"));

    // With its own manifest it is a real module, whatever its size.
    let i = inspected(&[
        ("pom.xml", BOOT_POM),
        ("src/main/java/A.java", "class A {}\n"),
        ("src/main/java/B.java", "class B {}\n"),
        ("etl/pyproject.toml", "[project]\nname = \"etl\"\n"),
        ("etl/run.py", "print(1)\n"),
    ]);
    assert!(!incidental(&i, "lang:python"));
}

#[test]
fn spring_and_graalvm_are_seen_on_maven() {
    let pom = r#"<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent><artifactId>svc</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency></dependencies><profiles><profile><id>native</id><build><plugins><plugin><groupId>org.graalvm.buildtools</groupId><artifactId>native-maven-plugin</artifactId><version>0.10.3</version></plugin></plugins></build></profile></profiles></project>"#;
    let i = inspected(&[("pom.xml", pom)]);
    let found = tags(&i);
    for tag in [
        "framework:spring-boot",
        "framework:spring",
        "framework:spring-security",
        "runtime:graalvm",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
}

#[test]
fn graalvm_is_seen_from_its_configuration_alone() {
    let i = inspected(&[(
        "src/main/resources/META-INF/native-image/acme/app/reflect-config.json",
        "[]\n",
    )]);
    assert!(tags(&i).contains("runtime:graalvm"));
}

#[test]
fn plain_spring_batch_and_cloud_are_their_own_tags() {
    let pom = r#"<project><artifactId>a</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId><version>6.1.0</version></dependency><dependency><groupId>org.springframework.batch</groupId><artifactId>spring-batch-core</artifactId><version>5.1.0</version></dependency><dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-starter</artifactId><version>4.1.0</version></dependency></dependencies></project>"#;
    let found_in = inspected(&[("pom.xml", pom)]);
    let found = tags(&found_in);
    for tag in [
        "framework:spring",
        "framework:spring-batch",
        "framework:spring-cloud",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
    assert!(!found.contains("framework:spring-boot"), "{found:?}");
}

#[test]
fn a_maven_bom_is_a_choice_of_platform_and_a_managed_version_is_not() {
    let pom = r#"<project><artifactId>a</artifactId><dependencyManagement><dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.3.4</version><type>pom</type><scope>import</scope></dependency>
        <dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId><version>4.29.1</version></dependency>
    </dependencies></dependencyManagement></project>"#;
    let i = inspected(&[("pom.xml", pom)]);
    let found = tags(&i);
    assert!(found.contains("framework:spring-boot"), "{found:?}");
    assert!(!found.contains("db:liquibase"), "{found:?}");
}

#[test]
fn a_gradle_build_in_a_subfolder_has_its_own_catalog_and_settings() {
    let i = inspected(&[
        ("backend/settings.gradle.kts", "rootProject.name = \"b\"\n"),
        (
            "backend/gradle/libs.versions.toml",
            "[versions]\nboot = \"3.3.4\"\n[plugins]\nspring-boot = { id = \"org.springframework.boot\", version.ref = \"boot\" }\n",
        ),
        (
            "backend/build.gradle.kts",
            "plugins {\n  java\n  alias(libs.plugins.spring.boot)\n}\n",
        ),
        (
            "frontend/package.json",
            r#"{"dependencies":{"@angular/core":"^18.0.0"}}"#,
        ),
    ]);
    assert!(tags_of(&i, "backend").contains("framework:spring-boot"));
    assert!(tags_of(&i, "frontend").contains("framework:angular"));
    assert_eq!(gradle_coverage(&i, "backend"), CoverageStatus::Complete);
}

#[test]
fn a_subfolder_builds_shared_blocks_reach_its_own_projects() {
    let i = inspected(&[
        ("backend/settings.gradle", "include 'api'\n"),
        (
            "backend/build.gradle",
            "subprojects { apply plugin: 'org.springframework.boot' }\n",
        ),
        ("backend/api/build.gradle", "dependencies { }\n"),
    ]);
    assert!(tags_of(&i, "backend/api").contains("framework:spring-boot"));
    assert!(!tags_of(&i, "backend").contains("framework:spring-boot"));
}

#[test]
fn a_nested_build_logic_is_tooling_not_a_module() {
    let i = inspected(&[
        ("backend/settings.gradle", "rootProject.name = 'b'\n"),
        ("backend/build.gradle.kts", "plugins { java }\n"),
        (
            "backend/buildSrc/build.gradle.kts",
            "dependencies { implementation(\"org.springframework.boot:spring-boot-gradle-plugin:3.3.4\") }\n",
        ),
        ("backend/buildSrc/src/main/kotlin/a.gradle.kts", "x\n"),
    ]);
    assert!(i.modules.iter().all(|m| m.id != "backend/buildSrc"));
    assert!(!tags(&i).contains("framework:spring-boot"));
    // What the conventions add stays open.
    assert_eq!(gradle_coverage(&i, "backend"), CoverageStatus::Partial);
}

#[test]
fn kotlin_shorthand_and_typesafe_projects_leave_coverage_complete() {
    let i = inspected(&[(
        "build.gradle.kts",
        "plugins { kotlin(\"jvm\") version \"2.0.0\" }\ndependencies {\n  testImplementation(kotlin(\"test\"))\n  implementation(projects.core)\n  \"implementation\"(\"org.springframework.boot:spring-boot-starter-web:3.3.4\")\n}\n",
    )]);
    assert_eq!(gradle_coverage(&i, "."), CoverageStatus::Complete);
    assert!(
        i.fact("dep:.:gradle:org.jetbrains.kotlin:kotlin-test")
            .is_some()
    );
    assert!(tags(&i).contains("framework:spring-boot"));
}

#[test]
fn a_plugin_declared_with_apply_false_says_nothing_of_the_project() {
    let i = inspected(&[
        (
            "build.gradle.kts",
            "plugins {\n  id(\"org.springframework.boot\") version \"3.3.2\" apply false\n}\n",
        ),
        (
            "settings.gradle.kts",
            "include(\"lib\")\ninclude(\"app\")\n",
        ),
        ("lib/build.gradle.kts", "plugins { java }\n"),
        (
            "app/build.gradle.kts",
            "plugins { id(\"org.springframework.boot\") }\n",
        ),
    ]);
    assert!(!tags_of(&i, ".").contains("framework:spring-boot"));
    assert!(!tags_of(&i, "lib").contains("framework:spring-boot"));
    assert!(tags_of(&i, "app").contains("framework:spring-boot"));
}

#[test]
fn the_dependency_management_plugin_is_read_as_what_it_says() {
    let i = inspected(&[(
        "build.gradle",
        "plugins { id 'java' }\ndependencyManagement {\n  imports { mavenBom 'org.springframework.boot:spring-boot-dependencies:3.3.4' }\n  dependencies { dependency 'org.liquibase:liquibase-core:4.29.1' }\n}\n",
    )]);
    let found = tags(&i);
    assert!(found.contains("framework:spring-boot"), "{found:?}");
    assert!(!found.contains("db:liquibase"), "{found:?}");
}

#[test]
fn a_tests_sample_project_is_not_a_module() {
    let i = inspected(&[
        ("pom.xml", "<project><artifactId>a</artifactId></project>"),
        (
            "src/test/resources/projects/sample/pom.xml",
            r#"<project><artifactId>s</artifactId><dependencies><dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId><version>4</version></dependency></dependencies></project>"#,
        ),
        ("testdata/chart/Chart.yaml", "apiVersion: v2\n"),
        ("testdata/main.tf", "x\n"),
    ]);
    assert_eq!(i.modules.len(), 1, "{:?}", i.modules);
    let found = tags(&i);
    assert!(!found.contains("db:liquibase"), "{found:?}");
    assert!(!found.contains("infra:helm"), "{found:?}");
    assert!(!found.contains("infra:terraform"), "{found:?}");
}

#[test]
fn requirement_files_are_read_however_they_are_laid_out() {
    let i = inspected(&[
        ("py/requirements/base.txt", "django==5.0\n"),
        ("py/dev-requirements.txt", "pytest\n"),
        ("py/app.py", "print(1)\n"),
    ]);
    let py = tags_of(&i, "py");
    assert!(py.contains("framework:django"), "{py:?}");
    assert!(py.contains("test:pytest"), "{py:?}");
    assert!(i.modules.iter().all(|m| m.id != "py/requirements"));
}

#[test]
fn an_unreadable_requirements_folder_leaves_its_module_open() {
    let big = "x==1\n".repeat(500_000);
    let i = inspected(&[("requirements/base.txt", big.as_str())]);
    let pypi = i
        .coverage
        .iter()
        .find(|c| c.module == "." && c.area == "pypi")
        .unwrap();
    assert_eq!(pypi.status, CoverageStatus::Failed);
}

#[test]
fn test_projects_are_seen_by_what_they_are_written_in() {
    let i = inspected(&[
        ("specs/login.spec", "# Login\n"),
        ("concepts/a.cpt", "# A\n"),
        ("robot/login.robot", "*** Test Cases ***\n"),
        ("features/login.feature", "Feature: x\n"),
        ("load/plan.jmx", "<jmeterTestPlan/>\n"),
        ("api/x.postman_collection.json", "{}\n"),
        ("testng.xml", "<suite/>\n"),
        ("karma.conf.js", "module.exports = 1;\n"),
        ("packaging/app.spec", "Name: app\n"),
    ]);
    let found = tags(&i);
    for tag in [
        "test:gauge",
        "test:robot-framework",
        "test:cucumber",
        "test:jmeter",
        "test:postman",
        "test:testng",
        "test:karma",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
}

#[test]
fn test_frameworks_are_seen_in_manifests() {
    let dep = |g: &str, a: &str| {
        format!(
            "<dependency><groupId>{g}</groupId><artifactId>{a}</artifactId><version>1</version></dependency>"
        )
    };
    let pom = format!(
        "<project><artifactId>e2e</artifactId><dependencies>{}{}{}{}{}{}{}{}</dependencies></project>",
        dep("com.thoughtworks.gauge", "gauge-java"),
        dep("io.cucumber", "cucumber-java"),
        dep("org.seleniumhq.selenium", "selenium-java"),
        dep("org.testng", "testng"),
        dep("org.mockito", "mockito-core"),
        dep("io.rest-assured", "rest-assured"),
        dep("io.gatling", "gatling-app"),
        dep("org.wiremock", "wiremock"),
    );
    let i = inspected(&[
        ("pom.xml", pom.as_str()),
        (
            "py/requirements.txt",
            "robotframework==7.0\nrobotframework-seleniumlibrary\nlocust\nbehave\ngetgauge\n",
        ),
        (
            "web/package.json",
            r#"{"devDependencies":{"karma":"6","jasmine-core":"5","mocha":"10","webdriverio":"9","@pact-foundation/pact":"12"}}"#,
        ),
    ]);
    let found = tags(&i);
    for tag in [
        "test:gauge",
        "test:cucumber",
        "test:selenium",
        "test:testng",
        "test:mockito",
        "test:rest-assured",
        "test:gatling",
        "test:wiremock",
        "test:robot-framework",
        "test:locust",
        "test:karma",
        "test:jasmine",
        "test:mocha",
        "test:webdriverio",
        "test:pact",
    ] {
        assert!(found.contains(tag), "{tag}: {found:?}");
    }
}

#[test]
fn openapi_is_seen_from_a_specification_or_the_tools_around_one() {
    for (path, text) in [
        ("api/openapi.yaml", "openapi: 3.0.3\ninfo: {}\n"),
        ("docs/public.yml", "# Our API\n---\nopenapi: \"3.1.0\"\n"),
        ("swagger.json", r#"{ "swagger": "2.0", "info": {} }"#),
        ("contracts/v1.json", r#"{"info":{},"openapi":"3.0.1"}"#),
    ] {
        let i = inspected(&[(path, text)]);
        assert!(tags(&i).contains("api:openapi"), "{path}");
    }
    let pom = r#"<project><artifactId>a</artifactId><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId><version>7.0.0</version></plugin></plugins></build></project>"#;
    assert!(tags(&inspected(&[("pom.xml", pom)])).contains("api:openapi"));
    let npm = r#"{"dependencies":{"@nestjs/swagger":"7"}}"#;
    assert!(tags(&inspected(&[("package.json", npm)])).contains("api:openapi"));
    // A page that mentions it is not one, nor is a sample in a test's fixtures.
    let i = inspected(&[("docs/guide.yaml", "description: we use openapi: 3 here\n")]);
    assert!(!tags(&i).contains("api:openapi"));
    let i = inspected(&[("testdata/petstore.yaml", "openapi: 3.0.3\n")]);
    assert!(!tags(&i).contains("api:openapi"));
}

#[test]
fn sample_code_in_a_tests_fixtures_is_no_language_of_the_project() {
    let i = inspected(&[
        ("pom.xml", "<project><artifactId>a</artifactId></project>"),
        ("testdata/example/main.py", "print(1)\n"),
    ]);
    assert!(!tags(&i).contains("lang:python"));
}

#[test]
fn gradle_details_codex_found() {
    let i = inspected(&[(
        "build.gradle.kts",
        "plugins { id(\"org.springframework.boot\") version \"3.3.2\" apply false; }\ndependencies { implementation(kotlin(\"stdlib\", \"1.9.24\")) }\n",
    )]);
    assert!(!tags(&i).contains("framework:spring-boot"));
    let fact = i
        .fact("dep:.:gradle:org.jetbrains.kotlin:kotlin-stdlib")
        .unwrap();
    assert!(serde_json::to_string(fact).unwrap().contains("1.9.24"));
}

#[test]
fn caches_do_not_use_up_the_content_checks() {
    let mut files: Vec<(String, String)> = (0..1500)
        .map(|n| (format!(".angular/cache/18/{n}.json"), "{}".to_string()))
        .collect();
    files.push((
        "z/public.yaml".into(),
        "openapi: 3.0.3\ninfo: {title: x, version: '1'}\npaths: {}\n".into(),
    ));
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let i = inspected(&borrowed);
    assert_eq!(i.scan.files_seen, 1);
    assert!(tags(&i).contains("api:openapi"));
}

#[test]
fn charts_do_not_use_up_the_content_checks() {
    let mut files: Vec<(String, String)> = (0..6000)
        .map(|n| {
            (
                format!("charts/a{}/templates/r{n}.yaml", n % 40),
                "apiVersion: v1\nkind: ConfigMap\n".to_string(),
            )
        })
        .collect();
    files.push(("charts/a0/Chart.yaml".into(), "apiVersion: v2\n".into()));
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let i = inspected(&borrowed);
    let content = i
        .coverage
        .iter()
        .find(|c| c.module == "." && c.area == "content")
        .unwrap();
    assert_eq!(content.status, CoverageStatus::Complete);
    // Six thousand files and one chart: one fact stands for them.
    let chart_facts = i.facts.iter().filter(|f| f.id.starts_with("file:")).count();
    assert_eq!(chart_facts, 1);
}

/// A fake credential of each shape Habi could meet. Each is planted in a place
/// inspection reads or lists; none may reach what it returns.
const CANARY: &str = "cAnArY0SeCrEt0VaLuE7";

#[test]
fn nothing_secret_reaches_the_inspection() {
    let token = format!("ghp_{CANARY}{CANARY}");
    let user_url = format!("git+https://{CANARY}@github.com/acme/x.git");
    let pass_url = format!("git+https://bot:{CANARY}@github.com/acme/x.git");
    let package = format!(
        r#"{{"name":"app","description":"A real app. Token {token} here.","dependencies":{{"a":"{user_url}","b":"{pass_url}","c":"https://x:{CANARY}@npm.acme.dev/c.tgz"}}}}"#
    );
    let requirements = format!(
        "--index-url https://u:{CANARY}@pypi.acme.dev/simple\nd @ https://{CANARY}@pypi.acme.dev/d.whl\ne==1.0\n"
    );
    let pyproject = format!(
        "[project]\nname = \"p\"\ndependencies = [\"f @ git+https://bot:{CANARY}@github.com/acme/f.git\"]\n"
    );
    let pom = format!(
        "<project><artifactId>m</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>{token}</version></dependency></dependencies></project>"
    );
    let gradle = format!(
        "dependencies {{\n  implementation(\"g:a:{token}\")\n  implementation(\"https://x:{CANARY}@acme.dev/y\")\n}}\n"
    );
    let broken = format!("{{ \"token\": \"{CANARY}\", ");
    let readme = format!("# App\n\nThe key is {token} and the password=\"{CANARY}\" for it.\n");
    let long_password = "a".repeat(300);
    let tricky = format!(
        r#"{{"name":"t","dependencies":{{"long":"https://bot:{CANARY}{long_password}@acme.dev/a.tgz","blank":"https://:{CANARY}@acme.dev/b.tgz"}}}}"#
    );
    let property_pom = format!(
        "<project><artifactId>p</artifactId><properties><db.password>{CANARY}</db.password><acme.token>{CANARY}</acme.token></properties><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${{db.password}}</version></dependency><dependency><groupId>g</groupId><artifactId>b</artifactId><version>${{acme.token}}</version></dependency></dependencies></project>"
    );
    let long_requirement = format!("-e https://bot:{CANARY}{long_password}@acme.dev/x\n");
    let state = format!(r#"{{"version":4,"outputs":{{"db":{{"value":"{CANARY}"}}}}}}"#);
    let mut files: Vec<(String, String)> = vec![
        ("package.json".into(), package),
        ("README.md".into(), readme),
        ("py/requirements.txt".into(), requirements),
        ("wheel/pyproject.toml".into(), pyproject),
        ("jvm/pom.xml".into(), pom),
        ("gr/build.gradle.kts".into(), gradle),
        ("broken/package.json".into(), broken),
        ("tricky/package.json".into(), tricky),
        ("props/pom.xml".into(), property_pom),
        ("req/requirements.txt".into(), long_requirement),
    ];
    // Files that must not even be listed.
    for hidden in [
        "terraform.tfstate",
        "infra/terraform.tfstate.backup",
        "prod.tfvars",
        "plan.tfplan",
        ".databrickscfg",
        ".terraformrc",
        ".env",
        ".pypirc",
        ".npmrc",
        ".vault-token",
        "k8s/secrets.yaml",
        "charts/a/values-secrets.yaml",
        ".docker/config.json",
        ".aws/credentials",
        ".kube/config",
        ".databricks/.databricks-login.json",
        ".ssh/id_rsa",
    ] {
        files.push((hidden.into(), state.clone()));
    }
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let i = inspected(&borrowed);

    let json = serde_json::to_string(&i).unwrap();
    for planted in [CANARY, "ghp_"] {
        let leaks: Vec<&str> = json
            .match_indices(planted)
            .map(|(at, _)| json.get(at.saturating_sub(120)..at + 40).unwrap_or(""))
            .collect();
        assert!(leaks.is_empty(), "{leaks:#?}");
    }
    // `files` is left out of the JSON and rules can match on it.
    for listed in &i.files {
        assert!(!listed.contains("tfstate"), "{listed}");
        assert!(!listed.contains("tfplan"), "{listed}");
        assert!(!listed.contains("tfvars"), "{listed}");
        assert!(!listed.contains("secrets"), "{listed}");
        assert!(!listed.ends_with(".databrickscfg"), "{listed}");
        assert!(!listed.starts_with(".docker/"), "{listed}");
    }
    // The dependencies themselves are still read.
    assert!(i.fact("dep:.:npm:a").is_some());
    assert!(i.fact("dep:py:pypi:e").is_some());
}
