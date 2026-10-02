//! Derived characteristics ("tags") such as `framework:spring-boot`.
//!
//! Each tag in the registry says which facts establish it and what kind of
//! evidence its absence depends on. Matching uses `basis` to decide whether
//! "tag not found" means false (the relevant evidence is complete) or unknown.

use super::Collector;
use super::model::FactSubject;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TagBasis {
    /// Established from build manifests (dependencies, plugins).
    Manifest,
    /// Established from files present in the tree.
    Files,
    /// Either.
    Both,
}

pub struct TagRule {
    pub tag: &'static str,
    pub label: &'static str,
    pub basis: TagBasis,
    /// Dependency name patterns (`*` wildcard).
    pub dependencies: &'static [&'static str],
    /// File roles.
    pub files: &'static [&'static str],
}

pub const TAG_RULES: &[TagRule] = &[
    TagRule {
        tag: "framework:spring-boot",
        label: "Spring Boot",
        basis: TagBasis::Manifest,
        dependencies: &["org.springframework.boot:*", "org.springframework.boot"],
        files: &[],
    },
    TagRule {
        tag: "framework:quarkus",
        label: "Quarkus",
        basis: TagBasis::Manifest,
        dependencies: &["io.quarkus:*", "io.quarkus"],
        files: &[],
    },
    TagRule {
        tag: "framework:micronaut",
        label: "Micronaut",
        basis: TagBasis::Manifest,
        dependencies: &["io.micronaut:*", "io.micronaut.*"],
        files: &[],
    },
    TagRule {
        tag: "framework:react",
        label: "React",
        basis: TagBasis::Manifest,
        dependencies: &["react"],
        files: &[],
    },
    TagRule {
        tag: "framework:vue",
        label: "Vue",
        basis: TagBasis::Manifest,
        dependencies: &["vue"],
        files: &[],
    },
    TagRule {
        tag: "framework:angular",
        label: "Angular",
        basis: TagBasis::Manifest,
        dependencies: &["@angular/core"],
        files: &[],
    },
    TagRule {
        tag: "framework:next",
        label: "Next.js",
        basis: TagBasis::Manifest,
        dependencies: &["next"],
        files: &[],
    },
    TagRule {
        tag: "framework:svelte",
        label: "Svelte",
        basis: TagBasis::Manifest,
        dependencies: &["svelte"],
        files: &[],
    },
    TagRule {
        tag: "framework:express",
        label: "Express",
        basis: TagBasis::Manifest,
        dependencies: &["express"],
        files: &[],
    },
    TagRule {
        tag: "framework:nestjs",
        label: "NestJS",
        basis: TagBasis::Manifest,
        dependencies: &["@nestjs/core"],
        files: &[],
    },
    TagRule {
        tag: "build:vite",
        label: "Vite",
        basis: TagBasis::Manifest,
        dependencies: &["vite"],
        files: &[],
    },
    TagRule {
        tag: "test:junit",
        label: "JUnit",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.junit.jupiter:*",
            "junit:junit",
            "org.springframework.boot:spring-boot-starter-test",
        ],
        files: &[],
    },
    TagRule {
        tag: "test:testcontainers",
        label: "Testcontainers",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.testcontainers:*",
            "testcontainers",
            "@testcontainers/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "test:jest",
        label: "Jest",
        basis: TagBasis::Both,
        dependencies: &["jest"],
        files: &["test-config:jest"],
    },
    TagRule {
        tag: "test:vitest",
        label: "Vitest",
        basis: TagBasis::Both,
        dependencies: &["vitest"],
        files: &["test-config:vitest"],
    },
    TagRule {
        tag: "test:playwright",
        label: "Playwright",
        basis: TagBasis::Both,
        dependencies: &["@playwright/test", "playwright"],
        files: &["test-config:playwright"],
    },
    TagRule {
        tag: "test:cypress",
        label: "Cypress",
        basis: TagBasis::Both,
        dependencies: &["cypress"],
        files: &["test-config:cypress"],
    },
    TagRule {
        tag: "db:liquibase",
        label: "Liquibase",
        basis: TagBasis::Both,
        dependencies: &["org.liquibase:*", "org.liquibase.gradle", "liquibase"],
        files: &["liquibase-changelog"],
    },
    TagRule {
        tag: "db:flyway",
        label: "Flyway",
        basis: TagBasis::Both,
        dependencies: &["org.flywaydb:*", "org.flywaydb.flyway"],
        files: &["flyway-migration"],
    },
    TagRule {
        tag: "orm:jpa",
        label: "JPA / Hibernate",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.springframework.boot:spring-boot-starter-data-jpa",
            "jakarta.persistence:jakarta.persistence-api",
            "javax.persistence:*",
            "org.hibernate.orm:hibernate-core",
            "org.hibernate:hibernate-core",
            "org.springframework.data:spring-data-jpa",
        ],
        files: &[],
    },
    TagRule {
        tag: "db:jooq",
        label: "jOOQ",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.jooq:*",
            "org.springframework.boot:spring-boot-starter-jooq",
            "nu.studer.jooq",
            "org.jooq.jooq-codegen-gradle",
        ],
        files: &[],
    },
    TagRule {
        tag: "api:openapi",
        label: "OpenAPI specification",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["openapi"],
    },
    TagRule {
        tag: "api:springdoc",
        label: "springdoc (generated OpenAPI)",
        basis: TagBasis::Manifest,
        dependencies: &["org.springdoc:*"],
        files: &[],
    },
    TagRule {
        tag: "ci:github-actions",
        label: "GitHub Actions",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["ci:github-actions"],
    },
    TagRule {
        tag: "ci:gitlab",
        label: "GitLab CI",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["ci:gitlab"],
    },
    TagRule {
        tag: "container:docker",
        label: "Docker",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["container:dockerfile"],
    },
    TagRule {
        tag: "agents:agents-md",
        label: "AGENTS.md instructions",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["agent-instructions:agents-md"],
    },
    TagRule {
        tag: "agents:claude-md",
        label: "CLAUDE.md instructions",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["agent-instructions:claude-md"],
    },
    TagRule {
        tag: "agents:cursor-rules",
        label: "Cursor rules",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["agent-instructions:cursor-rules"],
    },
    TagRule {
        tag: "agents:skills",
        label: "Agent skills in the project",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &[
            "agent-skill:claude-code",
            "agent-skill:agents",
            "agent-skill:cursor",
        ],
    },
];

/// Language tags are derived from source file extensions.
pub const LANGUAGE_TAGS: &[(&str, &str)] = &[
    ("lang:java", "Java"),
    ("lang:kotlin", "Kotlin"),
    ("lang:typescript", "TypeScript"),
    ("lang:javascript", "JavaScript"),
    ("lang:python", "Python"),
    ("lang:go", "Go"),
    ("lang:rust", "Rust"),
    ("lang:csharp", "C#"),
];

pub fn rule(tag: &str) -> Option<&'static TagRule> {
    TAG_RULES.iter().find(|r| r.tag == tag)
}

/// Basis for absence reasoning, or `None` for tags Habi cannot detect (such
/// tags can only be established by a user declaration).
pub fn basis(tag: &str) -> Option<TagBasis> {
    if LANGUAGE_TAGS.iter().any(|(t, _)| *t == tag) {
        return Some(TagBasis::Files);
    }
    rule(tag).map(|r| r.basis)
}

/// True for tags established from file roles that are only recognized by
/// reading content (OpenAPI, Liquibase changelogs). Their absence also
/// depends on the `content` coverage area.
pub fn needs_content(tag: &str) -> bool {
    rule(tag).is_some_and(|r| {
        r.files
            .iter()
            .any(|role| super::files::CONTENT_ROLES.contains(role))
    })
}

pub fn label(tag: &str) -> String {
    if let Some((_, l)) = LANGUAGE_TAGS.iter().find(|(t, _)| *t == tag) {
        return (*l).to_string();
    }
    rule(tag)
        .map(|r| r.label.to_string())
        .unwrap_or_else(|| tag.to_string())
}

/// Natural phrase for a condition on a tag: "uses Spring Boot", "contains Java code".
pub fn phrase(tag: &str) -> String {
    let label = label(tag);
    if tag.starts_with("lang:") {
        format!("contains {label} code")
    } else if tag == "api:openapi" {
        "has an OpenAPI specification".into()
    } else if tag.starts_with("agents:") {
        format!("has {label}")
    } else if rule(tag).is_some() {
        format!("uses {label}")
    } else {
        format!("is `{tag}`")
    }
}

/// Simple `*` wildcard match, linear time, no regex.
pub fn wildcard_match(pattern: &str, value: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let mut rest = value;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else if let Some((_, after)) = rest.split_once(part) {
            rest = after;
        } else {
            return false;
        }
    }
    true
}

/// Adds derived tag facts based on dependency and file facts.
pub fn derive(out: &mut Collector, files: &[(String, u64)], module_of: &dyn Fn(&str) -> String) {
    let snapshot: Vec<(String, String, FactSubject)> = out
        .facts
        .iter()
        .map(|f| (f.id.clone(), f.module.clone(), f.subject.clone()))
        .collect();
    for rule in TAG_RULES {
        for (id, module, subject) in &snapshot {
            let hit = match subject {
                FactSubject::Dependency { name, .. } => {
                    rule.dependencies.iter().any(|p| wildcard_match(p, name))
                }
                FactSubject::File { role, .. } => rule.files.contains(&role.as_str()),
                FactSubject::Tag { .. } => false,
            };
            if hit {
                out.tag(module, rule.tag, id);
            }
        }
    }

    // Languages: count source files per module.
    let mut first: std::collections::BTreeMap<(String, &'static str), (String, u32)> =
        Default::default();
    for (path, _) in files {
        if let Some(lang) = super::files::language_of(path) {
            let entry = first
                .entry((module_of(path), lang))
                .or_insert_with(|| (path.clone(), 0));
            entry.1 += 1;
        }
    }
    for ((module, lang), (example, count)) in first {
        out.language(&module, lang, &example, count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards() {
        assert!(wildcard_match("org.jooq:*", "org.jooq:jooq"));
        assert!(!wildcard_match("org.jooq:*", "org.jooqx:jooq"));
        assert!(wildcard_match("*-starter-*", "spring-boot-starter-web"));
        assert!(wildcard_match("react", "react"));
        assert!(!wildcard_match("react", "react-dom"));
    }
}
