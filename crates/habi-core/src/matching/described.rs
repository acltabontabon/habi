//! What a skill says it is for: the technologies its own name and
//! description name, as a rule Habi can evaluate.
//!
//! Most published skills declare no applicability, so Habi reads their words.
//! A lexicon maps the ways people write each detectable technology ("Next.js",
//! "GitHub Actions", "C#") to its inspection tag. Matching is deterministic and
//! errs toward silence: a missed skill can still be found by browsing, a wrong
//! recommendation costs trust.
//!
//! - Terms match whole words. Punctuation inside a term (`Next.js`, `C#`,
//!   `.NET`) is part of it, and `Java` never matches inside `JavaScript`.
//! - Words that are also English match only capitalised ("React", not "react
//!   to"), and some only beside a qualifier: `Spring Boot`, `Echo framework`,
//!   `Express app`. "Go" at the start of a sentence needs a programming word
//!   after it ("Go concurrency", not "Go through").
//! - A technology right after a negation ("not for Django", "instead of Jest")
//!   does not count, nor does the rest of that list.
//! - Names are lowercase, so only tokens that are unambiguous on their own
//!   count (`django`, `playwright`; not `go`, `next`, `spring` or `express`).
//! - A term stands for a tag only when every project with the tag is one the
//!   skill is about. Technologies Habi has no tag for (React Native, Nuxt,
//!   ASP.NET, Cloudflare Workers) name nothing; they do not
//!   stand in for a broader framework or language.
//! - A framework is the more specific claim: once one is named, languages are
//!   dropped. A skill naming more than five technologies is about none of them.

use super::condition::Condition;
use regex::{Regex, RegexSet};
use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// One technology a skill's own words name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    /// The inspection tag it stands for (`framework:react`).
    pub tag: &'static str,
    /// The words as they appear in the text.
    pub term: String,
}

/// More technologies than this and a skill is about none of them.
const MAX_TAGS: usize = 5;

/// One way of writing a technology, and when it counts.
struct Term {
    tag: &'static str,
    /// The words. A space also matches `-`, `_` or several spaces.
    text: &'static str,
    /// Only this capitalisation counts.
    cased: bool,
    /// The next word (lowercase) must be one of these; empty means any.
    then: &'static [&'static str],
    /// The next word must not be one of these.
    not_then: &'static [&'static str],
    /// At the start of a sentence, the next word must be one of these; empty
    /// means no extra condition.
    initial: &'static [&'static str],
}

/// A term in any capitalisation.
const fn term(tag: &'static str, text: &'static str) -> Term {
    Term {
        tag,
        text,
        cased: false,
        then: &[],
        not_then: &[],
        initial: &[],
    }
}

/// A term that counts only as capitalised, because the word is also English.
const fn cased(tag: &'static str, text: &'static str) -> Term {
    Term {
        cased: true,
        ..term(tag, text)
    }
}

impl Term {
    const fn then(self, words: &'static [&'static str]) -> Term {
        Term {
            then: words,
            ..self
        }
    }

    const fn not_then(self, words: &'static [&'static str]) -> Term {
        Term {
            not_then: words,
            ..self
        }
    }

    const fn initial(self, words: &'static [&'static str]) -> Term {
        Term {
            initial: words,
            ..self
        }
    }

    fn allows_next(&self, next: Option<&str>) -> bool {
        (self.then.is_empty() || next.is_some_and(|w| self.then.contains(&w)))
            && !next.is_some_and(|w| self.not_then.contains(&w))
    }

    fn pattern(&self) -> String {
        let words: Vec<String> = self.text.split(' ').map(regex::escape).collect();
        let flags = if self.cased { "" } else { "(?i)" };
        format!("{flags}{}", words.join(r"[\s_-]+"))
    }
}

/// Words after "Go" that make it an instruction ("Go through", "Go-to-market").
const GO_VERBS: &[&str] = &[
    "to", "through", "back", "ahead", "over", "into", "beyond", "further", "deeper", "up", "down",
    "out", "off", "away", "live",
];

/// Words after "Go" (opening a sentence or a name) that make it the language.
const GO_NOUNS: &[&str] = &[
    "code",
    "codebase",
    "codebases",
    "concurrency",
    "module",
    "modules",
    "package",
    "packages",
    "project",
    "projects",
    "service",
    "services",
    "microservices",
    "backend",
    "backends",
    "api",
    "apis",
    "server",
    "servers",
    "cli",
    "programming",
    "development",
    "developer",
    "developers",
    "testing",
    "tests",
    "generics",
    "errors",
    "interfaces",
    "idioms",
    "style",
    "conventions",
    "best",
    "performance",
    "application",
    "applications",
    "apps",
    "library",
    "libraries",
    "toolchain",
    "web",
];

/// Words after "Express" that make it the framework.
const EXPRESS_NOUNS: &[&str] = &[
    "app",
    "apps",
    "application",
    "applications",
    "server",
    "servers",
    "api",
    "apis",
    "backend",
    "backends",
    "middleware",
    "route",
    "routes",
    "routing",
    "router",
    "routers",
    "handler",
    "handlers",
    "endpoint",
    "endpoints",
    "framework",
    "service",
    "services",
    "project",
    "projects",
    "controller",
    "controllers",
];

/// Words after "Beam" that make it Apache Beam ("Beam pipelines", not "beam search").
const BEAM_NOUNS: &[&str] = &[
    "pipeline",
    "pipelines",
    "sdk",
    "runner",
    "runners",
    "job",
    "jobs",
    "transform",
    "transforms",
];

/// How descriptions name each tag. Every tag in `TAG_RULES` and
/// `LANGUAGE_TAGS` except `agents:*` has at least one term (tested).
static DESCRIPTION_TERMS: &[Term] = &[
    // JVM
    term("framework:spring-boot", "Spring Boot"),
    term("framework:spring-boot", "SpringBoot"),
    // Every Spring Boot project is a Spring Framework project.
    cased("framework:spring", "Spring Framework"),
    cased("framework:spring-security", "Spring Security"),
    cased("framework:spring-batch", "Spring Batch"),
    cased("framework:spring-cloud", "Spring Cloud"),
    term("runtime:graalvm", "GraalVM"),
    term("framework:quarkus", "Quarkus"),
    term("framework:micronaut", "Micronaut"),
    term("test:junit", "JUnit"),
    term("test:junit", "JUnit4"),
    term("test:junit", "JUnit5"),
    term("test:testcontainers", "Testcontainers"),
    term("db:liquibase", "Liquibase"),
    term("db:flyway", "Flyway"),
    cased("orm:jpa", "JPA"),
    cased("orm:jpa", "Hibernate"),
    term("orm:jpa", "Jakarta Persistence"),
    term("db:jooq", "jOOQ"),
    term("api:springdoc", "springdoc"),
    // JavaScript and TypeScript
    cased("framework:react", "React").not_then(&["to", "native"]),
    term("framework:react", "React.js"),
    term("framework:react", "ReactJS"),
    cased("framework:vue", "Vue"),
    term("framework:vue", "Vue.js"),
    term("framework:vue", "VueJS"),
    cased("framework:angular", "Angular").not_then(&[
        "momentum",
        "velocity",
        "acceleration",
        "frequency",
    ]),
    term("framework:angular", "@angular"),
    term("framework:next", "Next.js"),
    term("framework:next", "NextJS"),
    term("framework:next", "Next App Router"),
    term("framework:next", "next.config"),
    cased("framework:svelte", "Svelte"),
    term("framework:express", "Express.js"),
    term("framework:express", "ExpressJS"),
    cased("framework:express", "Express").then(EXPRESS_NOUNS),
    cased("framework:express", "Node.js and Express"),
    cased("framework:express", "Node.js/Express"),
    cased("framework:express", "Node/Express"),
    term("framework:nestjs", "NestJS"),
    term("framework:nestjs", "Nest.js"),
    term("build:vite", "Vite"),
    cased("test:jest", "Jest"),
    term("test:jest", "jest.config"),
    term("test:vitest", "Vitest"),
    term("test:playwright", "Playwright"),
    term("test:cypress", "Cypress"),
    // Go
    cased("framework:gin", "Gin"),
    term("framework:gin", "gin-gonic"),
    cased("framework:echo", "Echo").then(&["framework"]),
    cased("framework:echo", "Echo web framework"),
    term("framework:echo", "labstack/echo"),
    // React has a Fiber too.
    cased("framework:fiber", "Go Fiber"),
    term("framework:fiber", "gofiber"),
    cased("framework:fiber", "Fiber").then(&["framework"]),
    cased("framework:fiber", "Fiber web framework"),
    cased("framework:wails", "Wails"),
    term("orm:gorm", "GORM"),
    // Rust
    term("framework:axum", "Axum"),
    term("framework:actix", "Actix"),
    term("framework:tauri", "Tauri"),
    term("framework:tokio", "Tokio"),
    cased("orm:diesel", "Diesel").not_then(&["engine", "engines", "fuel", "generator"]),
    term("db:sqlx", "SQLx"),
    // Python
    term("framework:django", "Django"),
    cased("framework:flask", "Flask"),
    term("framework:fastapi", "FastAPI"),
    term("orm:sqlalchemy", "SQLAlchemy"),
    term("test:pytest", "pytest"),
    term("test:pytest", "py.test"),
    // PHP
    term("framework:laravel", "Laravel"),
    term("framework:symfony", "Symfony"),
    cased("orm:doctrine", "Doctrine"),
    term("test:phpunit", "PHPUnit"),
    // Data
    cased("data:dbt", "dbt"),
    cased("data:airflow", "Airflow"),
    term("data:airflow", "Apache Airflow"),
    term("data:dagster", "Dagster"),
    cased("data:prefect", "Prefect"),
    term("data:spark", "Apache Spark"),
    term("data:spark", "PySpark"),
    cased("data:spark", "Spark"),
    term("data:beam", "Apache Beam"),
    cased("data:beam", "Beam").then(BEAM_NOUNS),
    term("data:kafka", "Kafka"),
    cased("data:great-expectations", "Great Expectations"),
    term("data:great-expectations", "great_expectations"),
    term("data:pandas", "pandas"),
    term("data:polars", "Polars"),
    term("data:duckdb", "DuckDB"),
    term("data:databricks", "Databricks"),
    cased("data:delta", "Delta Lake"),
    term("data:mlflow", "MLflow"),
    term("data:jupyter", "Jupyter"),
    // Infrastructure
    term("infra:terraform", "Terraform"),
    term("infra:terraform", "OpenTofu"),
    term("infra:terragrunt", "Terragrunt"),
    cased("infra:helm", "Helm"),
    term("infra:helm", "helm chart"),
    term("infra:helm", "helm charts"),
    // Azure Kubernetes Service and Google Kubernetes Engine are clouds of their own.
    term("infra:kubernetes", "Kubernetes").not_then(&["service", "engine"]),
    term("infra:kubernetes", "K8s"),
    term("infra:kubernetes", "kubectl"),
    term("infra:kustomize", "Kustomize"),
    term("infra:ansible", "Ansible"),
    term("infra:pulumi", "Pulumi"),
    // Delivery
    term("api:openapi", "OpenAPI"),
    term("api:openapi", "Swagger"),
    term("ci:github-actions", "GitHub Actions"),
    term("ci:github-actions", "GitHub Action"),
    term("ci:github-actions", "GitHub workflow"),
    term("ci:github-actions", "GitHub workflows"),
    term("ci:github-actions", ".github/workflows"),
    cased("ci:github-actions", "GHA"),
    term("ci:gitlab", "GitLab CI"),
    term("ci:gitlab", "GitLab pipeline"),
    term("ci:gitlab", "GitLab pipelines"),
    term("container:docker", "Docker"),
    term("container:docker", "Dockerfile"),
    term("container:docker", "Dockerfiles"),
    // Languages
    cased("lang:java", "Java"),
    term("lang:kotlin", "Kotlin"),
    term("lang:typescript", "TypeScript"),
    term("lang:javascript", "JavaScript"),
    term("lang:python", "Python"),
    term("lang:python", "Python3"),
    term("lang:go", "Golang"),
    cased("lang:go", "Go").not_then(GO_VERBS).initial(GO_NOUNS),
    cased("lang:rust", "Rust").not_then(&["free", "proof", "resistant"]),
    term("lang:csharp", "C#"),
    term("lang:csharp", "CSharp"),
    cased("lang:csharp", ".NET"),
    term("lang:csharp", "dotnet"),
    term("lang:php", "PHP"),
    cased("lang:scala", "Scala"),
    cased("lang:hcl", "HCL"),
    cased("lang:shell", "Bash"),
    term("lang:shell", "ShellCheck"),
    term("lang:shell", "shell script"),
    term("lang:shell", "shell scripts"),
    term("lang:shell", "shell scripting"),
    cased("test:bats", "Bats"),
    // Test automation. Gauge is also a metric; Karate, Pact and Karma are also words.
    cased("test:gauge", "Gauge").then(&[
        "test",
        "tests",
        "spec",
        "specs",
        "framework",
        "testing",
        "automation",
    ]),
    term("test:gauge", "getgauge"),
    term("test:gauge", "gauge-java"),
    term("test:robot-framework", "Robot Framework"),
    term("test:robot-framework", "RobotFramework"),
    cased("test:cucumber", "Cucumber"),
    cased("test:cucumber", "Gherkin"),
    cased("test:selenium", "Selenium"),
    term("test:testng", "TestNG"),
    cased("test:spock", "Spock").then(&["test", "tests", "spec", "specs", "framework", "testing"]),
    term("test:mockito", "Mockito"),
    term("test:rest-assured", "REST Assured"),
    term("test:rest-assured", "RestAssured"),
    cased("test:karate", "Karate").then(&["dsl", "test", "tests", "framework", "testing"]),
    cased("test:gatling", "Gatling"),
    term("test:jmeter", "JMeter"),
    term("test:k6", "k6"),
    cased("test:locust", "Locust"),
    cased("test:karma", "Karma").then(&["test", "tests", "runner", "config", "testing"]),
    cased("test:jasmine", "Jasmine"),
    cased("test:mocha", "Mocha"),
    term("test:webdriverio", "WebdriverIO"),
    cased("test:appium", "Appium"),
    cased("test:pact", "Pact").then(&[
        "contract",
        "contracts",
        "test",
        "tests",
        "testing",
        "broker",
    ]),
    term("test:wiremock", "WireMock"),
    cased("test:postman", "Postman"),
    term("test:postman", "newman"),
];

/// How skill names (lowercase tokens, space-separated here) name a tag. Only
/// tokens that cannot be ordinary words; capitalisation cannot help here.
static NAME_TERMS: &[Term] = &[
    term("framework:spring-boot", "spring boot"),
    term("framework:spring-boot", "springboot"),
    term("framework:spring", "spring framework"),
    term("framework:spring-security", "spring security"),
    term("framework:spring-batch", "spring batch"),
    term("framework:spring-cloud", "spring cloud"),
    term("runtime:graalvm", "graalvm"),
    term("framework:quarkus", "quarkus"),
    term("framework:micronaut", "micronaut"),
    term("test:junit", "junit"),
    term("test:testcontainers", "testcontainers"),
    term("db:liquibase", "liquibase"),
    term("db:flyway", "flyway"),
    term("orm:jpa", "jpa"),
    term("orm:jpa", "hibernate"),
    term("db:jooq", "jooq"),
    term("api:springdoc", "springdoc"),
    // `react-to-feedback`, `react-native`, and the ReAct agent loop.
    term("framework:react", "react").not_then(&[
        "to",
        "native",
        "agent",
        "agents",
        "loop",
        "prompting",
    ]),
    term("framework:react", "reactjs"),
    term("framework:vue", "vue"),
    term("framework:vue", "vuejs"),
    term("framework:angular", "angular"),
    term("framework:next", "nextjs"),
    term("framework:next", "next js"),
    term("framework:svelte", "svelte"),
    term("framework:express", "expressjs"),
    term("framework:express", "express js"),
    term("framework:nestjs", "nestjs"),
    term("framework:nestjs", "nest js"),
    term("build:vite", "vite"),
    term("test:jest", "jest"),
    term("test:vitest", "vitest"),
    term("test:playwright", "playwright"),
    term("test:cypress", "cypress"),
    term("framework:gin", "gin gonic"),
    term("framework:fiber", "gofiber"),
    term("framework:fiber", "go fiber"),
    term("framework:wails", "wails"),
    term("orm:gorm", "gorm"),
    term("framework:axum", "axum"),
    term("framework:actix", "actix"),
    term("framework:tauri", "tauri"),
    term("framework:tokio", "tokio"),
    term("db:sqlx", "sqlx"),
    term("framework:django", "django"),
    term("framework:flask", "flask"),
    term("framework:fastapi", "fastapi"),
    term("orm:sqlalchemy", "sqlalchemy"),
    term("test:pytest", "pytest"),
    term("framework:laravel", "laravel"),
    term("framework:symfony", "symfony"),
    term("test:phpunit", "phpunit"),
    term("data:dbt", "dbt"),
    term("data:airflow", "airflow"),
    term("data:dagster", "dagster"),
    term("data:spark", "pyspark"),
    term("data:spark", "apache spark"),
    term("data:beam", "apache beam"),
    term("data:kafka", "kafka"),
    term("data:great-expectations", "great expectations"),
    term("data:pandas", "pandas"),
    term("data:polars", "polars"),
    term("data:duckdb", "duckdb"),
    term("api:openapi", "openapi"),
    term("api:openapi", "swagger"),
    term("ci:github-actions", "github actions"),
    term("ci:github-actions", "github action"),
    term("ci:github-actions", "gha"),
    term("ci:gitlab", "gitlab ci"),
    term("container:docker", "docker"),
    term("container:docker", "dockerfile"),
    term("lang:java", "java"),
    term("lang:kotlin", "kotlin"),
    term("lang:typescript", "typescript"),
    term("lang:javascript", "javascript"),
    term("lang:python", "python"),
    term("lang:go", "golang"),
    // `go-concurrency`, not `go-live-checklist` or `go-to-market`.
    term("lang:go", "go").then(GO_NOUNS),
    term("lang:rust", "rust"),
    term("lang:csharp", "csharp"),
    term("lang:csharp", "dotnet"),
    term("lang:php", "php"),
    term("lang:scala", "scala"),
    term("lang:shell", "bash"),
    term("lang:shell", "shell script"),
    term("lang:shell", "shell scripts"),
    term("lang:shell", "shell scripting"),
    term("lang:shell", "shellcheck"),
    term("test:bats", "bats"),
    term("test:gauge", "getgauge"),
    term("test:gauge", "gauge test"),
    term("test:gauge", "gauge tests"),
    term("test:robot-framework", "robot framework"),
    term("test:robot-framework", "robotframework"),
    term("test:cucumber", "cucumber"),
    term("test:cucumber", "gherkin"),
    term("test:selenium", "selenium"),
    term("test:testng", "testng"),
    term("test:mockito", "mockito"),
    term("test:rest-assured", "rest assured"),
    term("test:rest-assured", "restassured"),
    term("test:gatling", "gatling"),
    term("test:jmeter", "jmeter"),
    term("test:k6", "k6"),
    term("test:locust", "locust"),
    term("test:webdriverio", "webdriverio"),
    term("test:appium", "appium"),
    term("test:wiremock", "wiremock"),
    term("test:postman", "postman"),
    term("data:databricks", "databricks"),
    term("data:delta", "delta lake"),
    term("data:mlflow", "mlflow"),
    term("data:jupyter", "jupyter"),
    term("infra:terraform", "terraform"),
    term("infra:terraform", "opentofu"),
    term("infra:terragrunt", "terragrunt"),
    term("infra:helm", "helm"),
    term("infra:kubernetes", "kubernetes"),
    term("infra:kubernetes", "k8s"),
    term("infra:kustomize", "kustomize"),
    term("infra:ansible", "ansible"),
    term("infra:pulumi", "pulumi"),
];

/// Description terms compiled once; a term that does not compile is skipped
/// (tested not to happen).
static DESCRIPTION: LazyLock<Vec<(&'static Term, Regex)>> = LazyLock::new(|| {
    DESCRIPTION_TERMS
        .iter()
        .filter_map(|t| Regex::new(&t.pattern()).ok().map(|re| (t, re)))
        .collect()
});

/// The same terms as one set, so a description is scanned once to learn
/// which terms appear at all; only those are then located.
static DESCRIPTION_SET: LazyLock<Option<RegexSet>> =
    LazyLock::new(|| RegexSet::new(DESCRIPTION.iter().map(|(_, re)| re.as_str())).ok());

/// Rules already read, by name and description: an overview reads every
/// skill of every library, and the words do not change between reads.
static READ: LazyLock<Mutex<HashMap<Words, Option<Condition>>>> = LazyLock::new(Default::default);
/// Rules remembered at once. Past this the cache starts over; a library can
/// hold any number of skills, and reading one again is cheap.
const MAX_REMEMBERED: usize = 4096;

/// How much of a name and a description is read, in characters. The Agent Skills
/// format allows 64 and 1,024; a library can hold longer ones, and what names a
/// skill's subject comes first.
const MAX_NAME_CHARS: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 1024;

/// The first `max` characters of `text`.
fn head(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((end, _)) => text.get(..end).unwrap_or(text),
        None => text,
    }
}

/// A skill's name and description.
type Words = (String, String);

/// Words that make the technology right after them an exclusion.
const NEGATIONS: &[&str] = &[
    "not",
    "no",
    "never",
    "without",
    "except",
    "excluding",
    "unlike",
    "neither",
    "nor",
    "don't",
    "doesn't",
    "isn't",
    "aren't",
];
const NEGATION_PAIRS: &[(&str, &str)] = &[("instead", "of"), ("rather", "than"), ("other", "than")];
/// Words allowed between a negation and the technology ("not for use with Django").
const FILLERS: &[&str] = &[
    "for",
    "use",
    "using",
    "used",
    "with",
    "in",
    "on",
    "to",
    "a",
    "an",
    "the",
    "any",
    "apply",
    "applicable",
    "relevant",
    "meant",
    "intended",
    "designed",
];
const MAX_FILLERS: usize = 3;
/// Words read back from a technology when looking for a negation.
const LOOKBACK_WORDS: usize = MAX_FILLERS + 2;

/// The technologies a skill's name and description name, in order of first
/// appearance (the name first). Languages are left out when anything more
/// specific is named.
pub fn mentions(name: &str, description: &str) -> Vec<Mention> {
    let name = head(name, MAX_NAME_CHARS);
    let description = head(description, MAX_DESCRIPTION_CHARS);
    let mut found: Vec<Mention> = Vec::new();
    let described = in_description(description)
        .into_iter()
        .map(|f| (f.tag, f.term));
    for (tag, term) in in_name(name).into_iter().chain(described) {
        if !found.iter().any(|m| m.tag == tag) {
            found.push(Mention { tag, term });
        }
    }
    if found.iter().any(|m| !m.tag.starts_with("lang:")) {
        found.retain(|m| !m.tag.starts_with("lang:"));
    }
    found
}

/// A rule from what the skill says it is for, or `None` when it names no
/// technology Habi can detect (or so many that it is about none of them).
pub fn described_rule(name: &str, description: &str) -> Option<Condition> {
    let name = head(name, MAX_NAME_CHARS);
    let description = head(description, MAX_DESCRIPTION_CHARS);
    let key = (name.to_string(), description.to_string());
    if let Some(rule) = READ.lock().ok().and_then(|read| read.get(&key).cloned()) {
        return rule;
    }
    let rule = read_rule(name, description);
    if let Ok(mut read) = READ.lock() {
        if read.len() >= MAX_REMEMBERED {
            read.clear();
        }
        read.insert(key, rule.clone());
    }
    rule
}

/// The technologies a described rule asks for, as people say them ("Spring
/// Boot", "Liquibase"), in the rule's order and without repeats.
pub fn names(rule: &Condition) -> Vec<String> {
    fn walk(c: &Condition, out: &mut Vec<String>) {
        match c {
            Condition::All { items } | Condition::Any { items } => {
                for item in items {
                    walk(item, out);
                }
            }
            Condition::Not { item } => walk(item, out),
            Condition::Tag { tag } => {
                let label = crate::inspect::tags::label(tag);
                if !out.contains(&label) {
                    out.push(label);
                }
            }
            Condition::Dependency { .. } | Condition::File { .. } => {}
        }
    }
    let mut out = Vec::new();
    walk(rule, &mut out);
    out
}

/// Says the skill works with any technology, so the ones it names are examples.
static AGNOSTIC: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:technology|tech|language|framework|stack|platform)[\s-]+(?:agnostic|independent)\b|\bany (?:programming )?language\b|\bany (?:tech(?:nology)? )?stack\b",
    )
    .ok()
});

/// Tags about how a project is built and shipped, not what it is built on.
const TOOLING: &[&str] = &["ci:", "container:", "build:", "infra:"];

/// The rule's tags, from strongest claim to weakest: the frameworks, data
/// stores, test tools and APIs the skill names; else a language its name
/// names (`java-development`), since a language a description mentions in
/// passing ("pure JavaScript", "Python + BigQuery") is true of too many
/// projects to say one fits; else the CI or container tooling it names.
fn read_rule(name: &str, description: &str) -> Option<Condition> {
    if AGNOSTIC.as_ref().is_some_and(|re| re.is_match(description)) {
        return None;
    }
    let tooling = |t: &str| TOOLING.iter().any(|p| t.starts_with(p));
    let language = |t: &str| t.starts_with("lang:");
    let stack = |t: &str| !tooling(t) && !language(t);
    let named: Vec<&'static str> = in_name(name).into_iter().map(|(tag, _)| tag).collect();
    let hits = in_description(description);
    // What the name names is what the skill is about; failing that, the first
    // technology the description names, with any listed alongside it
    // ("Django, Flask or FastAPI") — not every one it mentions on the way.
    let listed = |keep: &dyn Fn(&str) -> bool| -> Vec<&'static str> {
        // In "from Jest to Vitest" the project is leaving Jest behind.
        let leaving = |h: &Found| {
            words_before(description, h.start)
                .first()
                .map(String::as_str)
                == Some("from")
                && hits.iter().any(|o| o.start > h.end && keep(o.tag))
        };
        let mut out: Vec<&'static str> = Vec::new();
        let mut last: Option<usize> = None;
        for h in hits.iter().filter(|h| keep(h.tag) && !leaving(h)) {
            match last {
                Some(end) if !same_list(description, end, h.start) => break,
                _ => {}
            }
            if !out.contains(&h.tag) {
                out.push(h.tag);
            }
            last = Some(h.end);
        }
        out
    };
    let from_name = |keep: &dyn Fn(&str) -> bool| -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        for t in named.iter().copied().filter(|t| keep(t)) {
            if !out.contains(&t) {
                out.push(t);
            }
        }
        out
    };
    let tags = [
        from_name(&stack),
        listed(&stack),
        from_name(&language),
        from_name(&tooling),
        listed(&tooling),
    ]
    .into_iter()
    .find(|tags| !tags.is_empty())
    .unwrap_or_default();
    match tags.as_slice() {
        [] => None,
        [one] => Some(Condition::Tag {
            tag: (*one).to_string(),
        }),
        many if many.len() > MAX_TAGS => None,
        many => Some(Condition::Any {
            items: many
                .iter()
                .map(|t| Condition::Tag {
                    tag: (*t).to_string(),
                })
                .collect(),
        }),
    }
}

/// Tags the name's tokens name, in order, with the name's own spelling.
fn in_name(name: &str) -> Vec<(&'static str, String)> {
    let tokens = name_tokens(name);
    let mut found = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let longest = NAME_TERMS
            .iter()
            .filter_map(|t| {
                let words: Vec<&str> = t.text.split(' ').collect();
                let run = tokens.get(i..i + words.len())?;
                let same = run.iter().zip(&words).all(|(token, w)| token.2 == *w);
                let next = tokens.get(i + words.len()).map(|token| token.2.as_str());
                if !same || !t.allows_next(next) {
                    return None;
                }
                let spelled = name.get(run.first()?.0..run.last()?.1)?;
                Some((t.tag, spelled.to_string(), words.len()))
            })
            .max_by_key(|(_, _, len)| *len);
        match longest {
            Some((tag, spelled, len)) => {
                found.push((tag, spelled));
                i += len;
            }
            None => i += 1,
        }
    }
    found
}

/// Lowercase alphanumeric runs of a name, with their byte ranges.
fn name_tokens(name: &str) -> Vec<(usize, usize, String)> {
    let mut tokens = Vec::new();
    let mut start = None;
    let end = std::iter::once((name.len(), '-'));
    let mut previous: Option<char> = None;
    for (i, c) in name.char_indices().chain(end) {
        // A version on a name ("vue3", "python3") is not part of the word.
        if let (Some(p), Some(s)) = (previous, start)
            && p.is_alphabetic()
            && c.is_ascii_digit()
        {
            if let Some(token) = name.get(s..i) {
                tokens.push((s, i, token.to_lowercase()));
            }
            start = None;
        }
        previous = Some(c);
        match (c.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                if let Some(token) = name.get(s..i) {
                    tokens.push((s, i, token.to_lowercase()));
                }
                start = None;
            }
            _ => {}
        }
    }
    tokens
}

struct Hit {
    start: usize,
    end: usize,
    tag: &'static str,
}

/// A technology a description names, where it names it.
struct Found {
    tag: &'static str,
    term: String,
    start: usize,
    end: usize,
}

/// Tags the description names, in order of appearance, without negated ones.
fn in_description(text: &str) -> Vec<Found> {
    let mut hits = Vec::new();
    let present = DESCRIPTION_SET.as_ref().map(|set| set.matches(text));
    for (i, (term, pattern)) in DESCRIPTION.iter().enumerate() {
        if present.as_ref().is_some_and(|p| !p.matched(i)) {
            continue;
        }
        for m in pattern.find_iter(text) {
            let next = next_word(text, m.end());
            let next = next.as_deref();
            let counts = whole_word(text, m.start(), m.end())
                && !repository_slug(text, m.start(), m.end())
                && !likeness(text, m.end())
                && term.allows_next(next)
                && (term.initial.is_empty()
                    || !starts_sentence(text, m.start())
                    || next.is_some_and(|w| term.initial.contains(&w)));
            if counts {
                hits.push(Hit {
                    start: m.start(),
                    end: m.end(),
                    tag: term.tag,
                });
            }
        }
    }
    hits.sort_by_key(|h| (h.start, Reverse(h.end)));

    let mut found = Vec::new();
    // End of the latest negated mention, so "not for Django or Flask" drops both.
    let mut negated_to: Option<usize> = None;
    for hit in hits {
        let negated = negated(text, hit.start)
            || negated_to.is_some_and(|end| same_list(text, end, hit.start));
        if negated {
            negated_to = Some(negated_to.map_or(hit.end, |end| end.max(hit.end)));
        } else if let Some(spelled) = text.get(hit.start..hit.end) {
            found.push(Found {
                tag: hit.tag,
                term: spelled.to_string(),
                start: hit.start,
                end: hit.end,
            });
        }
    }
    found
}

/// A lowercase name right before a `/` is an owner in a repository address
/// (`expressjs/express`), not the technology. A scoped package (`@angular/core`)
/// or prose ("React/Next.js") is not.
fn repository_slug(text: &str, start: usize, end: usize) -> bool {
    let word = text.get(start..end).unwrap_or_default();
    text.get(end..).is_some_and(|rest| rest.starts_with('/'))
        && word.chars().all(|c| !c.is_uppercase())
        && !word.starts_with('@')
        && !text
            .get(..start)
            .is_some_and(|before| before.ends_with('@'))
}

/// "Vue-like" or "Jest-style" compares with the technology; it is not used.
fn likeness(text: &str, end: usize) -> bool {
    text.get(end..).is_some_and(|rest| {
        ["-like", "-style", "-esque", "-inspired"]
            .iter()
            .any(|s| rest.starts_with(s))
    })
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// No letter or digit touches the match on either side.
fn whole_word(text: &str, start: usize, end: usize) -> bool {
    let before = text.get(..start).and_then(|s| s.chars().next_back());
    let after = text.get(end..).and_then(|s| s.chars().next());
    !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
}

/// The word after `end` (lowercase), across spaces or a hyphen; `None` when
/// punctuation or the end of the text comes first.
fn next_word(text: &str, end: usize) -> Option<String> {
    let rest = text
        .get(end..)?
        .trim_start_matches(|c: char| c.is_whitespace() || c == '-');
    let word: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
    (!word.is_empty()).then(|| word.to_lowercase())
}

/// Whether `start` opens a sentence, a line or the text.
fn starts_sentence(text: &str, start: usize) -> bool {
    let before = text.get(..start).unwrap_or("").trim_end_matches(|c: char| {
        matches!(
            c,
            ' ' | '\t'
                | '"'
                | '\''
                | '('
                | '['
                | '*'
                | '_'
                | '`'
                | '#'
                | '>'
                | '-'
                | '•'
                | '“'
                | '‘'
        )
    });
    match before.chars().next_back() {
        None | Some('\n' | '\r' | '!' | '?') => true,
        Some('.') => !ends_with_abbreviation(before),
        Some(_) => false,
    }
}

/// "e.g." and the like do not end a sentence.
fn ends_with_abbreviation(before: &str) -> bool {
    let head = before.strip_suffix('.').unwrap_or(before);
    let word = head
        .rsplit(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("");
    ["e.g", "i.e", "eg", "ie", "vs", "cf"]
        .iter()
        .any(|a| word.eq_ignore_ascii_case(a))
}

/// A negation comes right before `start`, in the same clause, with at most a
/// few filler words between ("do not use for Django").
fn negated(text: &str, start: usize) -> bool {
    let words = words_before(text, start);
    let fillers = words
        .iter()
        .take_while(|w| FILLERS.contains(&w.as_str()))
        .count();
    if fillers > MAX_FILLERS {
        return false;
    }
    let mut rest = words.iter().skip(fillers).map(String::as_str);
    let (nearest, previous) = (rest.next(), rest.next());
    nearest.is_some_and(|w| NEGATIONS.contains(&w))
        || matches!((previous, nearest), (Some(p), Some(n)) if NEGATION_PAIRS.contains(&(p, n)))
}

/// Up to `LOOKBACK_WORDS` lowercase words before `start`, nearest first,
/// stopping at the start of the clause.
fn words_before(text: &str, start: usize) -> Vec<String> {
    let before = text.get(..start).unwrap_or("");
    let mut words = Vec::new();
    let mut word: Vec<char> = Vec::new();
    // The character after the current one, to tell "Node.js" from a full stop.
    let mut after: Option<char> = None;
    for c in before.chars().rev() {
        let c = if c == '’' { '\'' } else { c };
        if c.is_alphanumeric() || c == '\'' {
            word.push(c);
        } else {
            if !word.is_empty() {
                words.push(word.drain(..).rev().collect::<String>().to_lowercase());
            }
            let clause_ends = matches!(
                c,
                ',' | ';' | ':' | '(' | ')' | '[' | ']' | '!' | '?' | '\n'
            ) || (c == '.' && after.is_none_or(char::is_whitespace));
            if clause_ends || words.len() >= LOOKBACK_WORDS {
                return words;
            }
        }
        after = Some(c);
    }
    if !word.is_empty() {
        words.push(word.drain(..).rev().collect::<String>().to_lowercase());
    }
    words
}

/// Only list separators lie between `end` and `start` ("Django, Flask or FastAPI").
fn same_list(text: &str, end: usize, start: usize) -> bool {
    if start <= end {
        return true;
    }
    text.get(end..start).is_some_and(|gap| {
        gap.split(|c: char| c.is_whitespace() || matches!(c, ',' | '/' | '&'))
            .all(|w| {
                w.is_empty()
                    || ["or", "and", "nor"]
                        .iter()
                        .any(|s| w.eq_ignore_ascii_case(s))
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_head_of_a_long_description_is_read() {
        let padding = "lorem ipsum ".repeat(200);
        assert!(padding.len() > MAX_DESCRIPTION_CHARS);
        // What comes past the limit is not read at all, and costs no time.
        let late = format!("{padding}. Use with Django.");
        assert!(mentions("helper", &late).is_empty());
        assert_eq!(described_rule("helper", &late), None);
        assert!(!mentions("helper", "Use with Django.").is_empty());

        // Cut at a character, not a byte.
        assert_eq!(head("déjà", 2), "dé");
        assert_eq!(head("déjà", 4), "déjà");
        assert_eq!(head("déjà", 40), "déjà");
    }

    #[test]
    fn the_cache_of_rules_read_does_not_grow_past_its_limit() {
        for i in 0..MAX_REMEMBERED + 10 {
            described_rule(&format!("skill-{i}"), "Use with Django.");
        }
        assert!(READ.lock().unwrap().len() <= MAX_REMEMBERED);
        // Different words past the limit are the same words to the cache.
        let long = "x".repeat(10 * MAX_DESCRIPTION_CHARS);
        described_rule("one-name", &long);
        let key = (
            "one-name".to_string(),
            head(&long, MAX_DESCRIPTION_CHARS).to_string(),
        );
        assert!(READ.lock().unwrap().contains_key(&key));
    }
    use crate::inspect::tags::{LANGUAGE_TAGS, TAG_RULES, basis};

    fn tags(name: &str, description: &str) -> Vec<&'static str> {
        mentions(name, description)
            .into_iter()
            .map(|m| m.tag)
            .collect()
    }

    #[test]
    fn every_detectable_tag_has_a_term() {
        let detectable = TAG_RULES
            .iter()
            .map(|r| r.tag)
            .chain(LANGUAGE_TAGS.iter().map(|(t, _)| *t))
            .filter(|t| !t.starts_with("agents:"));
        for tag in detectable {
            assert!(
                DESCRIPTION_TERMS.iter().any(|t| t.tag == tag),
                "{tag} has no description term"
            );
        }
    }

    #[test]
    fn every_term_is_a_known_tag_and_compiles() {
        for t in DESCRIPTION_TERMS.iter().chain(NAME_TERMS) {
            assert!(basis(t.tag).is_some(), "{} is not a detectable tag", t.tag);
            assert!(!t.tag.starts_with("agents:"), "{}", t.tag);
            for word in t.then.iter().chain(t.not_then).chain(t.initial) {
                assert_eq!(*word, word.to_lowercase(), "{} after {}", word, t.text);
            }
        }
        for t in NAME_TERMS {
            assert_eq!(t.text, t.text.to_lowercase(), "name term {}", t.text);
        }
        assert_eq!(DESCRIPTION.len(), DESCRIPTION_TERMS.len());
        assert!(DESCRIPTION_SET.is_some());
    }

    /// Descriptions modelled on public skills: (name, description, tags in order).
    #[test]
    fn realistic_skills() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "react-best-practices",
                "React and Next.js performance optimization guidelines from Vercel Engineering. \
                 Use when writing, reviewing, or refactoring React/Next.js components, data \
                 fetching, or bundle size.",
                &["framework:react", "framework:next"],
            ),
            (
                "composition-patterns",
                "React composition patterns that scale: compound components, render props and \
                 context providers. Use when refactoring components with boolean prop sprawl.",
                &["framework:react"],
            ),
            (
                "react-native-skills",
                "React Native and Expo best practices for performant mobile apps: list \
                 virtualization, animations and native modules.",
                &[],
            ),
            (
                "django-perf-review",
                "Django performance code review. Use when asked to review Django performance, \
                 find N+1 queries, or optimise ORM access.",
                &["framework:django"],
            ),
            (
                "django-access-review",
                "Review Django views and serializers for access control bugs such as IDOR and \
                 missing permission checks.",
                &["framework:django"],
            ),
            (
                "webapp-testing",
                "Toolkit for interacting with and testing local web applications using \
                 Playwright. Supports verifying frontend functionality, debugging UI behaviour, \
                 capturing browser screenshots, and viewing browser logs.",
                &["test:playwright"],
            ),
            (
                "gha-security-review",
                "Find exploitable vulnerabilities in GitHub Actions workflows: script injection \
                 through untrusted inputs, pull_request_target misuse, and over-broad token \
                 permissions.",
                &["ci:github-actions"],
            ),
            (
                "wrangler",
                "Cloudflare Workers CLI for deploying, developing, and managing Workers, KV, R2, \
                 D1, Queues, Workflows and Containers. Load before running wrangler commands.",
                &[],
            ),
            (
                "workers-best-practices",
                "Reviews and authors Cloudflare Workers code against production best practices: \
                 streaming, floating promises, global state, secrets and bindings.",
                &[],
            ),
            (
                "test-driven-development",
                "Use when implementing any feature or bugfix, before writing implementation code.",
                &[],
            ),
            (
                "systematic-debugging",
                "Use when encountering any bug, test failure, or unexpected behavior, before \
                 proposing fixes.",
                &[],
            ),
            (
                "frontend-design",
                "Create distinctive, production-grade frontend interfaces with high design \
                 quality. Avoid generic AI aesthetics.",
                &[],
            ),
            (
                "pdf",
                "Comprehensive PDF manipulation toolkit for extracting text and tables, creating \
                 new PDFs, merging and splitting documents, and handling forms.",
                &[],
            ),
            (
                "kafka-consumer-patterns",
                "Patterns for reliable Kafka consumers: offset management, rebalancing, \
                 idempotent processing and dead-letter topics.",
                &["data:kafka"],
            ),
            (
                "dataframe-performance",
                "Speed up pandas and Polars workloads: vectorisation, avoiding apply, lazy \
                 frames, and when to reach for DuckDB.",
                &["data:pandas", "data:polars", "data:duckdb"],
            ),
            (
                "rust-async-patterns",
                "Async Rust with Tokio: spawning tasks, channels, cancellation, and never \
                 blocking the runtime.",
                &["framework:tokio"],
            ),
            (
                "golang-pro",
                "Write idiomatic Go code with goroutines, channels, and interfaces. Use for Go \
                 refactoring, concurrency problems, or performance tuning.",
                &["lang:go"],
            ),
            (
                "go-concurrency",
                "Go concurrency patterns: worker pools, fan-out, and context cancellation.",
                &["lang:go"],
            ),
            (
                "dotnet-best-practices",
                "Guidance for C# and .NET 8 projects: nullable reference types, async/await and \
                 dependency injection.",
                &["lang:csharp"],
            ),
            (
                "spring-boot-jpa",
                "Spring Boot data access with Spring Data JPA and Hibernate: entity mapping, N+1 \
                 queries and transactions in Java services.",
                &["framework:spring-boot", "orm:jpa"],
            ),
            (
                "springdoc-openapi",
                "Generate OpenAPI docs from Spring Boot controllers with springdoc.",
                &["api:springdoc", "api:openapi", "framework:spring-boot"],
            ),
            (
                "fastapi-endpoints",
                "Build FastAPI endpoints with Pydantic models, dependency injection and async \
                 SQLAlchemy sessions.",
                &["framework:fastapi", "orm:sqlalchemy"],
            ),
            (
                "pytest-fixtures",
                "Write maintainable pytest suites: fixtures, parametrisation and monkeypatching \
                 for Python projects.",
                &["test:pytest"],
            ),
            (
                "flask-blueprints",
                "Flask blueprints and app factories. Not for Django or FastAPI projects.",
                &["framework:flask"],
            ),
            (
                "laravel-eloquent",
                "Laravel Eloquent conventions: relationships, scopes and eager loading. Use when \
                 editing models in a Laravel app.",
                &["framework:laravel"],
            ),
            (
                "symfony-doctrine",
                "Symfony services and Doctrine entities, repositories and migrations.",
                &["framework:symfony", "orm:doctrine"],
            ),
            (
                "phpunit-tests",
                "PHPUnit test conventions for PHP 8 projects.",
                &["test:phpunit"],
            ),
            (
                "vitest-migration",
                "Migrate a test suite from Jest to Vitest, including mocks, timers and snapshots.",
                &["test:vitest", "test:jest"],
            ),
            (
                "vitest-setup",
                "Configure Vitest for a Vite project instead of Jest.",
                &["test:vitest", "build:vite"],
            ),
            (
                "cypress-e2e",
                "End-to-end tests with Cypress: stable selectors, network stubs and no arbitrary \
                 waits.",
                &["test:cypress"],
            ),
            (
                "nestjs-modules",
                "NestJS module, provider and guard patterns for TypeScript back ends.",
                &["framework:nestjs"],
            ),
            (
                "express-api",
                "Build REST APIs with Express: routing, middleware and error handling. Covers \
                 Express middleware ordering.",
                &["framework:express"],
            ),
            (
                "vue-composition",
                "Vue 3 Composition API patterns with script setup and Pinia stores.",
                &["framework:vue"],
            ),
            (
                "angular-signals",
                "Angular signals, standalone components and the new control flow.",
                &["framework:angular"],
            ),
            (
                "svelte5-runes",
                "Svelte 5 runes: $state, $derived and $effect.",
                &["framework:svelte"],
            ),
            (
                "typescript-strict",
                "Strict TypeScript compiler settings and type-level patterns.",
                &["lang:typescript"],
            ),
            (
                "gin-handlers",
                "Gin web framework handlers, binding and middleware for Go services.",
                &["framework:gin"],
            ),
            (
                "echo-server",
                "Routing and middleware with the Echo framework (labstack/echo) for Go.",
                &["framework:echo"],
            ),
            (
                "fiber-api",
                "REST APIs with Go Fiber (gofiber).",
                &["framework:fiber"],
            ),
            (
                "gorm-models",
                "GORM models, associations and transactions in Go.",
                &["orm:gorm"],
            ),
            (
                "wails-desktop",
                "Desktop apps with Wails: binding Go methods to the frontend.",
                &["framework:wails"],
            ),
            (
                "tauri-commands",
                "Tauri commands and events between the Rust core and the web front end.",
                &["framework:tauri"],
            ),
            (
                "axum-services",
                "HTTP services with Axum and Tokio, sharing state and handling errors.",
                &["framework:axum", "framework:tokio"],
            ),
            (
                "actix-web",
                "Actix Web handlers, extractors and middleware.",
                &["framework:actix"],
            ),
            (
                "diesel-orm",
                "Diesel schema, migrations and query builder patterns.",
                &["orm:diesel"],
            ),
            (
                "sqlx-queries",
                "Compile-time checked SQL with SQLx and Postgres in Rust.",
                &["db:sqlx"],
            ),
            (
                "kotlin-coroutines",
                "Kotlin coroutines and flows: structured concurrency, cancellation and testing.",
                &["lang:kotlin"],
            ),
            (
                "quarkus-native",
                "Quarkus native builds, with notes for Micronaut users.",
                &["framework:quarkus", "framework:micronaut"],
            ),
            (
                "testcontainers-integration",
                "Integration tests against real databases with Testcontainers and JUnit 5.",
                &["test:testcontainers", "test:junit"],
            ),
            (
                "liquibase-migrations",
                "Write safe Liquibase changelogs; also covers Flyway migrations.",
                &["db:liquibase", "db:flyway"],
            ),
            (
                "jooq-queries",
                "Type-safe SQL with jOOQ code generation.",
                &["db:jooq"],
            ),
            (
                "docker-compose-dev",
                "Local development with Docker Compose: service dependencies, volumes and \
                 healthchecks.",
                &["container:docker"],
            ),
            (
                "openapi-contracts",
                "Keep the OpenAPI (Swagger) specification in sync with the implementation.",
                &["api:openapi"],
            ),
            (
                "gitlab-ci-pipelines",
                "Fast, cacheable GitLab CI/CD pipelines with rules and needs.",
                &["ci:gitlab"],
            ),
            (
                "dbt-modeling",
                "dbt model conventions: staging, intermediate and mart layers.",
                &["data:dbt"],
            ),
            (
                "airflow-dags",
                "Author Apache Airflow DAGs with idempotent tasks and sensible retries.",
                &["data:airflow"],
            ),
            (
                "dagster-assets",
                "Software-defined assets, sensors and schedules in Dagster.",
                &["data:dagster"],
            ),
            (
                "prefect-flows",
                "Prefect flows and tasks with retries, caching and deployments.",
                &["data:prefect"],
            ),
            (
                "spark-tuning",
                "Tune Apache Spark and PySpark jobs: partitioning, shuffles, skew and caching.",
                &["data:spark"],
            ),
            (
                "beam-pipelines",
                "Design Apache Beam pipelines for batch and streaming.",
                &["data:beam"],
            ),
            (
                "great-expectations-suites",
                "Data quality checks with Great Expectations: expectation suites for pandas and \
                 Spark data.",
                &["data:great-expectations", "data:pandas", "data:spark"],
            ),
        ];
        for (name, description, want) in cases {
            assert_eq!(tags(name, description), *want, "{name}");
            let rule = described_rule(name, description);
            assert_eq!(rule.is_some(), !want.is_empty(), "{name}");
        }
    }

    #[test]
    fn infrastructure_and_script_skills_read_as_what_they_are() {
        for (name, description, want) in [
            (
                "terraform-module-library",
                "Build reusable Terraform modules for AWS, Azure and GCP.",
                "infra:terraform",
            ),
            (
                "helm-chart-scaffolding",
                "Design and manage Helm charts for packaging Kubernetes applications.",
                "infra:helm",
            ),
            (
                "k8s-manifest-generator",
                "Create production-ready Kubernetes manifests.",
                "infra:kubernetes",
            ),
            (
                "bash-defensive-patterns",
                "Master defensive Bash programming for production-grade scripts.",
                "lang:shell",
            ),
            (
                "shellcheck-configuration",
                "Master ShellCheck static analysis for shell script quality.",
                "lang:shell",
            ),
            (
                "java-add-graalvm-native-image-support",
                "GraalVM Native Image for Spring Boot, Micronaut and plain Java.",
                "runtime:graalvm",
            ),
            (
                "delta-tables",
                "Delta Lake table design and MERGE on Databricks.",
                "data:delta",
            ),
        ] {
            let found = rule_tags(name, description);
            assert!(found.iter().any(|t| t == want), "{name}: {found:?}");
        }
        // A cloud of its own is not any Kubernetes project.
        assert!(rule_tags("x", "Troubleshoot Azure Kubernetes Service clusters.").is_empty());
        assert!(rule_tags("x", "At the helm of a team.").is_empty());
        assert!(rule_tags("react-native-image", "Images in React Native.").is_empty());
        // A language in passing still names no language.
        assert!(rule_tags("deploy-notes", "Run a Bash command to deploy.").is_empty());
    }

    #[test]
    fn test_automation_skills_read_as_what_they_are() {
        for (name, description, want) in [
            (
                "gauge-specs",
                "Write Gauge specs for acceptance tests.",
                "test:gauge",
            ),
            (
                "robot-framework-keywords",
                "Robot Framework keywords.",
                "test:robot-framework",
            ),
            (
                "bdd",
                "Write Cucumber scenarios in Gherkin.",
                "test:cucumber",
            ),
            ("selenium-grid", "Selenium grid setups.", "test:selenium"),
            ("rest-assured-api-tests", "API tests.", "test:rest-assured"),
            ("load", "Load tests with k6.", "test:k6"),
            ("jmeter-plans", "Performance plans.", "test:jmeter"),
        ] {
            let found = rule_tags(name, description);
            assert!(found.iter().any(|t| t == want), "{name}: {found:?}");
        }
        for (name, description) in [
            ("metrics", "Expose a Gauge metric and a counter."),
            ("gauge-metrics", "How to gauge progress."),
            ("x", "Good Karma for the team."),
            ("x", "A Pact between teams."),
        ] {
            assert!(rule_tags(name, description).is_empty(), "{description}");
        }
    }

    #[test]
    fn a_skill_for_every_language_is_for_none() {
        let name = "code-review-any-language";
        let description = "Review code in Python, JavaScript, TypeScript, Java, Go, Rust, C# or \
                           PHP for correctness and readability.";
        assert_eq!(
            tags(name, description),
            [
                "lang:python",
                "lang:javascript",
                "lang:typescript",
                "lang:java",
                "lang:go",
                "lang:rust",
                "lang:csharp",
                "lang:php",
            ]
        );
        assert_eq!(described_rule(name, description), None);
    }

    #[test]
    fn five_technologies_still_make_a_rule() {
        let description = "Django, FastAPI, Flask, pytest and SQLAlchemy.";
        assert_eq!(tags("x", description).len(), 5);
        assert!(described_rule("x", description).is_some());
        let six = "Django, FastAPI, Flask, pytest, SQLAlchemy and pandas.";
        assert_eq!(described_rule("x", six), None);
    }

    #[test]
    fn ordinary_words_are_not_technologies() {
        let prose = [
            "React to review feedback quickly.",
            "Agents should react to failures.",
            "Express intent clearly in commit messages.",
            "Helps you express intent.",
            "Express delivery options.",
            "Spring cleaning for stale branches.",
            "The Spring release adds dark mode.",
            "Plan the next steps.",
            "Next, run the tests.",
            "Echo the output back to the user.",
            "Keep the codebase rust-free.",
            "Rust-free fittings only.",
            "Use beam search to rank candidates.",
            "Beam search decoding for summaries.",
            "Go through each file and fix lint errors.",
            "Go to the settings page.",
            "Go back to the previous step.",
            "Go ahead and commit.",
            "Go over the diff once more.",
            "Draft a Go-to-market plan.",
            "Reactive streams and backpressure.",
            "Keep reacting to alerts.",
            "Said in jest.",
            "Pour it from the flask.",
            "Angular momentum of the rotor.",
            "Diesel engine maintenance schedules.",
            "Assign the school prefect duties.",
            "A heavy dose of military doctrine.",
            "Fiber optics and fiber channels.",
            "Use the GitHub CLI to open pull requests.",
            "Build a ReAct agent loop.",
            "ASP.NET Core minimal APIs.",
            "Nuxt and SvelteKit routing.",
            "Node.js scripts and Deno tasks.",
            "VB.NET forms.",
        ];
        for text in prose {
            assert_eq!(tags("notes", text), Vec::<&str>::new(), "{text}");
        }
    }

    #[test]
    fn ambiguous_name_tokens_are_not_technologies() {
        for name in [
            "react-to-feedback",
            "react-agent",
            "react-native-expo",
            "go-live-checklist",
            "go-to-market",
            "next-steps",
            "spring-cleaning",
            "express-intent",
            "echo-chamber",
            "gin-rummy",
            "beam-search",
            "spark-ideas",
            "rusty-notes",
        ] {
            assert_eq!(tags(name, ""), Vec::<&str>::new(), "{name}");
        }
    }

    #[test]
    fn names_count_first_and_keep_their_spelling() {
        let found = mentions(
            "spring-boot-jpa",
            "Uses GitHub Actions and Spring Boot with JPA.",
        );
        assert_eq!(
            found,
            [
                Mention {
                    tag: "framework:spring-boot",
                    term: "spring-boot".into()
                },
                Mention {
                    tag: "orm:jpa",
                    term: "jpa".into()
                },
                Mention {
                    tag: "ci:github-actions",
                    term: "GitHub Actions".into()
                },
            ]
        );
        assert_eq!(tags("django_models", ""), ["framework:django"]);
        assert_eq!(tags("go-best-practices", ""), ["lang:go"]);
        assert_eq!(tags("next-js-routing", ""), ["framework:next"]);
        assert_eq!(tags("fiber-go-fiber", ""), ["framework:fiber"]);
    }

    #[test]
    fn whole_words_with_punctuation() {
        assert_eq!(
            tags("x", "Write JavaScript without classes."),
            ["lang:javascript"]
        );
        assert_eq!(tags("x", "Plain Java."), ["lang:java"]);
        assert_eq!(tags("x", "Idiomatic C#."), ["lang:csharp"]);
        assert_eq!(tags("x", "Targets (.NET 8)."), ["lang:csharp"]);
        assert_eq!(tags("x", "Built on next.js, mostly."), ["framework:next"]);
        assert_eq!(tags("x", "Covers React-based UIs."), ["framework:react"]);
        assert_eq!(tags("x", "Upgrades @angular/core."), ["framework:angular"]);
        assert_eq!(tags("x", "Uses `vite.config.ts`."), ["build:vite"]);
        assert_eq!(tags("x", "Not Vitest itself: Vite."), ["build:vite"]);
        assert_eq!(
            tags("x", "Edit .github/workflows files."),
            ["ci:github-actions"]
        );
        assert_eq!(
            tags("x", "Edit github-actions files."),
            ["ci:github-actions"]
        );
        let found = mentions("x", "Built on next.js.");
        assert_eq!(found.first().map(|m| m.term.as_str()), Some("next.js"));
    }

    #[test]
    fn go_needs_context_at_the_start_of_a_sentence() {
        assert_eq!(tags("x", "Go modules and workspaces."), ["lang:go"]);
        assert_eq!(tags("x", "Services written in Go."), ["lang:go"]);
        assert_eq!(tags("x", "Services in Go, mostly."), ["lang:go"]);
        assert_eq!(tags("x", "Languages, e.g. Go, are fine."), ["lang:go"]);
        assert_eq!(tags("x", "Fine. Go, too."), Vec::<&str>::new());
        assert_eq!(tags("x", "Done. Go back and check."), Vec::<&str>::new());
        assert_eq!(tags("x", "- Go through the list"), Vec::<&str>::new());
        assert_eq!(tags("x", "Then Go to Definition."), Vec::<&str>::new());
    }

    #[test]
    fn qualified_words() {
        assert_eq!(
            tags("x", "An Express app with routers."),
            ["framework:express"]
        );
        assert_eq!(tags("x", "Node.js and Express."), ["framework:express"]);
        assert_eq!(tags("x", "Uses Express.js."), ["framework:express"]);
        assert_eq!(tags("x", "The Echo framework."), ["framework:echo"]);
        assert_eq!(tags("x", "A Fiber framework app."), ["framework:fiber"]);
        assert_eq!(tags("x", "React Fiber internals."), ["framework:react"]);
        assert_eq!(tags("x", "Spring Framework beans."), ["framework:spring"]);
        assert_eq!(
            tags("x", "Spring Security filter chains."),
            ["framework:spring-security"]
        );
        assert_eq!(
            tags("x", "spring boot starters."),
            ["framework:spring-boot"]
        );
        assert_eq!(tags("x", "Beam pipelines on Dataflow."), ["data:beam"]);
        assert_eq!(tags("x", "Next App Router layouts."), ["framework:next"]);
    }

    #[test]
    fn negated_technologies_do_not_count() {
        assert_eq!(tags("x", "Use Vitest, not Jest."), ["test:vitest"]);
        assert_eq!(
            tags("x", "Not for Django or Flask projects; use FastAPI."),
            ["framework:fastapi"]
        );
        assert_eq!(
            tags("x", "Do not use for Django, Flask or FastAPI."),
            Vec::<&str>::new()
        );
        assert_eq!(
            tags("x", "Prefer pandas rather than Polars."),
            ["data:pandas"]
        );
        assert_eq!(
            tags("x", "Run Playwright without Docker."),
            ["test:playwright"]
        );
        assert_eq!(tags("x", "Not limited to React."), ["framework:react"]);
        assert_eq!(tags("x", "Not just for React."), ["framework:react"]);
        assert_eq!(
            tags("x", "React apps. Not for React Native."),
            ["framework:react"]
        );
        assert_eq!(tags("x", "Never use Jest. Vitest only."), ["test:vitest"]);
        // A negation in another clause does not reach.
        assert_eq!(
            tags("x", "Not a linter, Django checks."),
            ["framework:django"]
        );
    }

    #[test]
    fn languages_give_way_to_frameworks() {
        assert_eq!(
            tags("x", "Python services with Django."),
            ["framework:django"]
        );
        assert_eq!(
            tags("x", "Python and TypeScript."),
            ["lang:python", "lang:typescript"]
        );
        assert_eq!(tags("python-django", ""), ["framework:django"]);
    }

    /// The tags of the rule a skill gets, in order.
    fn rule_tags(name: &str, description: &str) -> Vec<String> {
        fn walk(c: &Condition, out: &mut Vec<String>) {
            match c {
                Condition::Tag { tag } => out.push(tag.clone()),
                Condition::Any { items } | Condition::All { items } => {
                    items.iter().for_each(|i| walk(i, out))
                }
                _ => {}
            }
        }
        let mut out = Vec::new();
        if let Some(rule) = described_rule(name, description) {
            walk(&rule, &mut out);
        }
        out
    }

    #[test]
    fn rules_claim_what_the_skill_is_about() {
        // What it is built on wins over the language and the tooling around it.
        assert_eq!(
            rule_tags("x", "Ship React apps in Docker images with GitHub Actions."),
            ["framework:react"]
        );
        // A language its name names is its subject; tooling it mentions is not.
        assert_eq!(
            rule_tags(
                "java-development",
                "Plain Java without a framework: Maven, Gradle and GitHub Actions."
            ),
            ["lang:java"]
        );
        // A language mentioned in passing fits too many projects to say one fits.
        assert!(
            rule_tags(
                "freecad-scripts",
                "Write FreeCAD Python scripts and macros."
            )
            .is_empty()
        );
        assert!(rule_tags("md-to-docx", "Convert Markdown to Word in pure JavaScript.").is_empty());
        // Tooling is the subject when nothing else is named.
        assert_eq!(
            rule_tags(
                "codeql",
                "Set up CodeQL scanning with GitHub Actions workflows."
            ),
            ["ci:github-actions"]
        );
        // A skill for any technology names examples, not its subject.
        assert!(rule_tags(
            "stack-blueprint",
            "Technology-agnostic generator: detects React, Angular or Spring Boot and documents it."
        )
        .is_empty());
        // The name says what the skill is about; what else it mentions does not widen it.
        assert_eq!(
            rule_tags(
                "fastapi-endpoints",
                "FastAPI endpoints backed by SQLAlchemy models."
            ),
            ["framework:fastapi"]
        );
        assert_eq!(
            rule_tags("vue3-composition", "Composition API patterns."),
            ["framework:vue"]
        );
        // Otherwise the first technology, with the ones listed alongside it.
        assert_eq!(
            rule_tags(
                "x",
                "Views for Django, Flask or FastAPI, with SQLAlchemy and pytest."
            ),
            ["framework:django", "framework:flask", "framework:fastapi"]
        );
        // A migration fits the projects that are making it, not those that made it.
        assert_eq!(
            rule_tags("x", "Migrate a test suite from Jest to Vitest."),
            ["test:vitest"]
        );
        // A comparison is not a use.
        assert_eq!(
            rule_tags("x", "A Vue-like store for Svelte apps."),
            ["framework:svelte"]
        );
        // A repository address is not the technology; a scoped package is.
        assert!(rule_tags("x", "Checks sponsors of expressjs/express and others.").is_empty());
        assert_eq!(
            rule_tags("x", "Upgrades @angular/core."),
            ["framework:angular"]
        );
    }

    #[test]
    fn rule_shape() {
        assert_eq!(described_rule("x", "Nothing technical."), None);
        assert_eq!(
            described_rule("x", "Playwright tests."),
            Some(Condition::Tag {
                tag: "test:playwright".into()
            })
        );
        assert_eq!(
            described_rule("x", "Playwright and Vitest tests, Playwright first."),
            Some(Condition::Any {
                items: vec![
                    Condition::Tag {
                        tag: "test:playwright".into()
                    },
                    Condition::Tag {
                        tag: "test:vitest".into()
                    },
                ]
            })
        );
    }
}
