//! Derived characteristics ("tags") such as `framework:spring-boot`.
//!
//! Each tag in the registry says which facts establish it and what kind of
//! evidence its absence depends on. Matching uses `basis` to decide whether
//! "tag not found" means false (the relevant evidence is complete) or unknown.

use super::Collector;
use super::model::{Ecosystem, FactSubject};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
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
        tag: "framework:spring",
        label: "Spring Framework",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.springframework:*",
            "org.springframework.boot:*",
            "org.springframework.boot",
        ],
        files: &[],
    },
    TagRule {
        tag: "framework:spring-security",
        label: "Spring Security",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.springframework.security:*",
            "org.springframework.boot:spring-boot-starter-security",
        ],
        files: &[],
    },
    TagRule {
        tag: "framework:spring-batch",
        label: "Spring Batch",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.springframework.batch:*",
            "org.springframework.boot:spring-boot-starter-batch",
        ],
        files: &[],
    },
    TagRule {
        tag: "framework:spring-cloud",
        label: "Spring Cloud",
        basis: TagBasis::Manifest,
        dependencies: &["org.springframework.cloud:*"],
        files: &[],
    },
    TagRule {
        tag: "runtime:graalvm",
        label: "GraalVM",
        basis: TagBasis::Both,
        dependencies: &["org.graalvm.*", "com.oracle.substratevm:*"],
        files: &["graalvm-config"],
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
        // No specification file settles it: a build Habi could only partly read
        // does not make its absence unknown.
        basis: TagBasis::Files,
        // Tools that generate from a specification or publish one.
        dependencies: &[
            "org.openapitools:*",
            "org.openapi.generator",
            "io.swagger.core.v3:*",
            "io.swagger:*",
            "io.swagger.parser.v3:*",
            "@openapitools/*",
            "@nestjs/swagger",
            "swagger-ui-express",
            "swagger-jsdoc",
            "openapi-typescript",
            "orval",
            "drf-spectacular",
            "drf-yasg",
            "apispec",
            "openapi-generator-cli",
            "github.com/getkin/kin-openapi",
            "github.com/swaggo/swag",
            "utoipa",
        ],
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
    // Go.
    TagRule {
        tag: "framework:gin",
        label: "Gin",
        basis: TagBasis::Manifest,
        dependencies: &["github.com/gin-gonic/gin"],
        files: &[],
    },
    TagRule {
        tag: "framework:echo",
        label: "Echo",
        basis: TagBasis::Manifest,
        dependencies: &["github.com/labstack/echo*"],
        files: &[],
    },
    TagRule {
        tag: "framework:fiber",
        label: "Fiber",
        basis: TagBasis::Manifest,
        dependencies: &["github.com/gofiber/fiber*"],
        files: &[],
    },
    TagRule {
        tag: "framework:wails",
        label: "Wails",
        basis: TagBasis::Manifest,
        dependencies: &["github.com/wailsapp/wails*"],
        files: &[],
    },
    TagRule {
        tag: "orm:gorm",
        label: "GORM",
        basis: TagBasis::Manifest,
        dependencies: &["gorm.io/gorm"],
        files: &[],
    },
    // Rust.
    TagRule {
        tag: "framework:axum",
        label: "Axum",
        basis: TagBasis::Manifest,
        dependencies: &["axum"],
        files: &[],
    },
    TagRule {
        tag: "framework:actix",
        label: "Actix Web",
        basis: TagBasis::Manifest,
        dependencies: &["actix-web"],
        files: &[],
    },
    TagRule {
        tag: "framework:tauri",
        label: "Tauri",
        basis: TagBasis::Manifest,
        dependencies: &["tauri"],
        files: &[],
    },
    TagRule {
        tag: "framework:tokio",
        label: "Tokio",
        basis: TagBasis::Manifest,
        dependencies: &["tokio"],
        files: &[],
    },
    TagRule {
        tag: "orm:diesel",
        label: "Diesel",
        basis: TagBasis::Manifest,
        dependencies: &["diesel"],
        files: &[],
    },
    TagRule {
        tag: "db:sqlx",
        label: "SQLx",
        basis: TagBasis::Manifest,
        dependencies: &["sqlx"],
        files: &[],
    },
    // Python.
    TagRule {
        tag: "framework:django",
        label: "Django",
        basis: TagBasis::Manifest,
        dependencies: &["django"],
        files: &[],
    },
    TagRule {
        tag: "framework:flask",
        label: "Flask",
        basis: TagBasis::Manifest,
        dependencies: &["flask"],
        files: &[],
    },
    TagRule {
        tag: "framework:fastapi",
        label: "FastAPI",
        basis: TagBasis::Manifest,
        dependencies: &["fastapi"],
        files: &[],
    },
    TagRule {
        tag: "orm:sqlalchemy",
        label: "SQLAlchemy",
        basis: TagBasis::Manifest,
        dependencies: &["sqlalchemy"],
        files: &[],
    },
    TagRule {
        tag: "test:pytest",
        label: "pytest",
        basis: TagBasis::Manifest,
        dependencies: &["pytest"],
        files: &[],
    },
    // PHP.
    TagRule {
        tag: "framework:laravel",
        label: "Laravel",
        basis: TagBasis::Manifest,
        dependencies: &["laravel/framework"],
        files: &[],
    },
    TagRule {
        tag: "framework:symfony",
        label: "Symfony",
        basis: TagBasis::Manifest,
        dependencies: &["symfony/framework-bundle"],
        files: &[],
    },
    TagRule {
        tag: "orm:doctrine",
        label: "Doctrine",
        basis: TagBasis::Manifest,
        dependencies: &["doctrine/orm"],
        files: &[],
    },
    TagRule {
        tag: "test:phpunit",
        label: "PHPUnit",
        basis: TagBasis::Manifest,
        dependencies: &["phpunit/phpunit"],
        files: &[],
    },
    // Data engineering: pipelines, orchestration, processing, streaming.
    TagRule {
        tag: "data:dbt",
        label: "dbt",
        basis: TagBasis::Both,
        dependencies: &["dbt-core", "dbt-*"],
        files: &["data:dbt-project"],
    },
    TagRule {
        tag: "data:airflow",
        label: "Airflow",
        basis: TagBasis::Manifest,
        dependencies: &["apache-airflow", "apache-airflow-*"],
        files: &[],
    },
    TagRule {
        tag: "data:dagster",
        label: "Dagster",
        basis: TagBasis::Manifest,
        dependencies: &["dagster", "dagster-*"],
        files: &[],
    },
    TagRule {
        tag: "data:prefect",
        label: "Prefect",
        basis: TagBasis::Manifest,
        dependencies: &["prefect"],
        files: &[],
    },
    TagRule {
        tag: "data:spark",
        label: "Spark",
        basis: TagBasis::Manifest,
        dependencies: &[
            "pyspark",
            "org.apache.spark:*",
            "databricks-connect",
            "delta-spark",
            "io.delta:delta-spark*",
        ],
        files: &[],
    },
    TagRule {
        tag: "data:beam",
        label: "Apache Beam",
        basis: TagBasis::Manifest,
        dependencies: &["apache-beam", "org.apache.beam:*"],
        files: &[],
    },
    TagRule {
        tag: "data:kafka",
        label: "Kafka",
        basis: TagBasis::Manifest,
        dependencies: &[
            "kafka-python",
            "confluent-kafka",
            "org.apache.kafka:*",
            "kafkajs",
            "github.com/segmentio/kafka-go",
            "rdkafka",
        ],
        files: &[],
    },
    TagRule {
        tag: "data:great-expectations",
        label: "Great Expectations",
        basis: TagBasis::Manifest,
        dependencies: &["great-expectations"],
        files: &[],
    },
    TagRule {
        tag: "data:pandas",
        label: "pandas",
        basis: TagBasis::Manifest,
        dependencies: &["pandas"],
        files: &[],
    },
    TagRule {
        tag: "data:polars",
        label: "Polars",
        basis: TagBasis::Manifest,
        dependencies: &["polars"],
        files: &[],
    },
    TagRule {
        tag: "data:duckdb",
        label: "DuckDB",
        basis: TagBasis::Manifest,
        dependencies: &["duckdb"],
        files: &[],
    },
    TagRule {
        tag: "data:databricks",
        label: "Databricks",
        basis: TagBasis::Both,
        dependencies: &["databricks-*", "dbt-databricks", "com.databricks:*"],
        files: &["data:databricks-bundle", "data:databricks-notebook"],
    },
    TagRule {
        tag: "data:delta",
        label: "Delta Lake",
        basis: TagBasis::Manifest,
        dependencies: &["delta-spark", "deltalake", "io.delta:*"],
        files: &[],
    },
    TagRule {
        tag: "data:mlflow",
        label: "MLflow",
        basis: TagBasis::Manifest,
        dependencies: &["mlflow", "mlflow-*", "org.mlflow:*"],
        files: &[],
    },
    TagRule {
        tag: "data:jupyter",
        label: "Jupyter notebooks",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["data:notebook"],
    },
    // Test automation.
    TagRule {
        tag: "test:gauge",
        label: "Gauge",
        basis: TagBasis::Both,
        dependencies: &[
            "com.thoughtworks.gauge:*",
            "getgauge",
            "gauge-ts",
            "gauge-js",
            "@getgauge/*",
        ],
        files: &["test-config:gauge"],
    },
    TagRule {
        tag: "test:robot-framework",
        label: "Robot Framework",
        basis: TagBasis::Both,
        dependencies: &["robotframework", "robotframework-*", "org.robotframework:*"],
        files: &["test-config:robot"],
    },
    TagRule {
        tag: "test:cucumber",
        label: "Cucumber",
        basis: TagBasis::Both,
        dependencies: &[
            "io.cucumber:*",
            "info.cukes:*",
            "@cucumber/*",
            "cucumber",
            "behave",
            "pytest-bdd",
            "github.com/cucumber/godog",
        ],
        files: &["test-config:gherkin"],
    },
    TagRule {
        tag: "test:selenium",
        label: "Selenium",
        basis: TagBasis::Manifest,
        dependencies: &[
            "org.seleniumhq.selenium:*",
            "selenium",
            "selenium-webdriver",
            "com.codeborne:selenide",
        ],
        files: &[],
    },
    TagRule {
        tag: "test:testng",
        label: "TestNG",
        basis: TagBasis::Both,
        dependencies: &["org.testng:*"],
        files: &["test-config:testng"],
    },
    TagRule {
        tag: "test:spock",
        label: "Spock",
        basis: TagBasis::Manifest,
        dependencies: &["org.spockframework:*"],
        files: &[],
    },
    TagRule {
        tag: "test:mockito",
        label: "Mockito",
        basis: TagBasis::Manifest,
        dependencies: &["org.mockito:*"],
        files: &[],
    },
    TagRule {
        tag: "test:rest-assured",
        label: "REST Assured",
        basis: TagBasis::Manifest,
        dependencies: &["io.rest-assured:*", "com.jayway.restassured:*"],
        files: &[],
    },
    TagRule {
        tag: "test:karate",
        label: "Karate",
        basis: TagBasis::Manifest,
        dependencies: &["com.intuit.karate:*", "io.karatelabs:*"],
        files: &[],
    },
    TagRule {
        tag: "test:gatling",
        label: "Gatling",
        basis: TagBasis::Manifest,
        dependencies: &[
            "io.gatling:*",
            "io.gatling.highcharts:*",
            "io.gatling.gatling",
            "gatling-*",
        ],
        files: &[],
    },
    TagRule {
        tag: "test:jmeter",
        label: "JMeter",
        basis: TagBasis::Both,
        dependencies: &["org.apache.jmeter:*", "com.lazerycode.jmeter:*"],
        files: &["test-config:jmeter"],
    },
    TagRule {
        tag: "test:k6",
        label: "k6",
        basis: TagBasis::Manifest,
        dependencies: &["k6", "@types/k6"],
        files: &[],
    },
    TagRule {
        tag: "test:locust",
        label: "Locust",
        basis: TagBasis::Manifest,
        dependencies: &["locust"],
        files: &[],
    },
    TagRule {
        tag: "test:karma",
        label: "Karma",
        basis: TagBasis::Both,
        dependencies: &["karma"],
        files: &["test-config:karma"],
    },
    TagRule {
        tag: "test:jasmine",
        label: "Jasmine",
        basis: TagBasis::Manifest,
        dependencies: &["jasmine", "jasmine-core"],
        files: &[],
    },
    TagRule {
        tag: "test:mocha",
        label: "Mocha",
        basis: TagBasis::Manifest,
        dependencies: &["mocha"],
        files: &[],
    },
    TagRule {
        tag: "test:webdriverio",
        label: "WebdriverIO",
        basis: TagBasis::Manifest,
        dependencies: &["webdriverio", "@wdio/*"],
        files: &[],
    },
    TagRule {
        tag: "test:appium",
        label: "Appium",
        basis: TagBasis::Manifest,
        dependencies: &["io.appium:*", "appium", "Appium-Python-Client"],
        files: &[],
    },
    TagRule {
        tag: "test:pact",
        label: "Pact",
        basis: TagBasis::Manifest,
        dependencies: &["au.com.dius.pact*", "@pact-foundation/*", "pact-python"],
        files: &[],
    },
    TagRule {
        tag: "test:wiremock",
        label: "WireMock",
        basis: TagBasis::Manifest,
        dependencies: &["org.wiremock:*", "com.github.tomakehurst:*", "wiremock"],
        files: &[],
    },
    TagRule {
        tag: "test:postman",
        label: "Postman collections",
        basis: TagBasis::Both,
        dependencies: &["newman"],
        files: &["test-config:postman"],
    },
    // Infrastructure: how the project is provisioned and deployed.
    TagRule {
        tag: "infra:terraform",
        label: "Terraform",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["infra:terraform-config"],
    },
    TagRule {
        tag: "infra:terragrunt",
        label: "Terragrunt",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["infra:terragrunt-config"],
    },
    TagRule {
        tag: "infra:helm",
        label: "Helm",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["infra:helm-chart"],
    },
    TagRule {
        tag: "infra:kubernetes",
        label: "Kubernetes",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &[
            "infra:helm-chart",
            "infra:kustomization",
            "kubernetes-manifest",
        ],
    },
    TagRule {
        tag: "infra:kustomize",
        label: "Kustomize",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["infra:kustomization"],
    },
    TagRule {
        tag: "infra:ansible",
        label: "Ansible",
        basis: TagBasis::Both,
        dependencies: &["ansible", "ansible-core"],
        files: &["infra:ansible-config"],
    },
    TagRule {
        tag: "infra:pulumi",
        label: "Pulumi",
        basis: TagBasis::Both,
        dependencies: &[
            "pulumi",
            "pulumi-*",
            "@pulumi/*",
            "github.com/pulumi/pulumi/*",
        ],
        files: &["infra:pulumi-project"],
    },
    TagRule {
        tag: "test:bats",
        label: "Bats",
        basis: TagBasis::Files,
        dependencies: &[],
        files: &["test-config:bats"],
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
            "agent-skill:gemini-cli",
            "agent-skill:copilot",
            "agent-skill:opencode",
            "agent-skill:junie",
        ],
    },
    // Where it runs and what it talks to. A product's own SDK is a narrow fact
    // about a project, so a skill for one part of a product can fit on it
    // (`matching::described`).
    TagRule {
        tag: "cloud:azure",
        label: "Azure",
        basis: TagBasis::Manifest,
        dependencies: &[
            "@azure/*",
            // Not all of `azure-*`: `azure-pipelines-task-lib` is Azure DevOps.
            "azure-ai-*",
            "azure-core",
            "azure-cosmos",
            "azure-data-*",
            "azure-eventgrid",
            "azure-eventhub*",
            "azure-functions",
            "azure-identity",
            "azure-keyvault*",
            "azure-mgmt-*",
            "azure-monitor-*",
            "azure-search-*",
            "azure-servicebus",
            "azure-storage-*",
            "azure_*",
            "com.azure:*",
            "com.microsoft.azure:*",
            "github.com/Azure/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "cloud:aws",
        label: "AWS",
        basis: TagBasis::Manifest,
        dependencies: &[
            "@aws-sdk/*",
            "aws-sdk",
            "aws-sdk-*",
            "aws-cdk-lib",
            "aws-config",
            "boto3",
            "software.amazon.awssdk:*",
            "com.amazonaws:*",
            "github.com/aws/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "cloud:gcp",
        label: "Google Cloud",
        basis: TagBasis::Manifest,
        dependencies: &[
            "@google-cloud/*",
            "google-cloud-*",
            "com.google.cloud:*",
            "cloud.google.com/go*",
        ],
        files: &[],
    },
    TagRule {
        tag: "cloud:cloudflare",
        label: "Cloudflare",
        basis: TagBasis::Both,
        dependencies: &["wrangler", "@cloudflare/*"],
        files: &["cloud:wrangler-config"],
    },
    TagRule {
        tag: "cloud:vercel",
        label: "Vercel",
        basis: TagBasis::Both,
        // Not all of `@vercel/*`: `@vercel/ncc` bundles GitHub Actions anywhere.
        dependencies: &[
            "vercel",
            "@vercel/analytics",
            "@vercel/blob",
            "@vercel/edge",
            "@vercel/functions",
            "@vercel/kv",
            "@vercel/node",
            "@vercel/postgres",
            "@vercel/speed-insights",
        ],
        files: &["cloud:vercel-config"],
    },
    TagRule {
        tag: "sdk:twilio",
        label: "Twilio",
        basis: TagBasis::Manifest,
        dependencies: &["twilio", "com.twilio.sdk:*", "github.com/twilio/*"],
        files: &[],
    },
    TagRule {
        tag: "sdk:stripe",
        label: "Stripe",
        basis: TagBasis::Manifest,
        dependencies: &["stripe", "@stripe/*", "com.stripe:*", "github.com/stripe/*"],
        files: &[],
    },
    TagRule {
        tag: "sdk:firebase",
        label: "Firebase",
        basis: TagBasis::Manifest,
        dependencies: &["firebase", "firebase-admin", "com.google.firebase:*"],
        files: &[],
    },
    TagRule {
        tag: "sdk:supabase",
        label: "Supabase",
        basis: TagBasis::Manifest,
        dependencies: &["supabase", "@supabase/*"],
        files: &[],
    },
    TagRule {
        tag: "sdk:sentry",
        label: "Sentry",
        basis: TagBasis::Manifest,
        dependencies: &[
            "sentry",
            "sentry-sdk",
            "@sentry/*",
            "io.sentry:*",
            "github.com/getsentry/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "sdk:openai",
        label: "OpenAI SDK",
        basis: TagBasis::Manifest,
        dependencies: &[
            "openai",
            "async-openai",
            "com.openai:*",
            "github.com/openai/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "sdk:mcp",
        label: "MCP SDK",
        basis: TagBasis::Manifest,
        dependencies: &[
            "@modelcontextprotocol/*",
            "mcp",
            "fastmcp",
            "rmcp",
            "io.modelcontextprotocol*:*",
            "github.com/modelcontextprotocol/*",
        ],
        files: &[],
    },
    TagRule {
        tag: "framework:react-native",
        label: "React Native",
        basis: TagBasis::Manifest,
        dependencies: &["react-native", "expo"],
        files: &[],
    },
    TagRule {
        tag: "framework:tailwind",
        label: "Tailwind CSS",
        basis: TagBasis::Manifest,
        dependencies: &["tailwindcss", "@tailwindcss/*"],
        files: &[],
    },
    TagRule {
        tag: "api:graphql",
        label: "GraphQL",
        basis: TagBasis::Manifest,
        dependencies: &[
            "graphql",
            "@apollo/*",
            "graphene",
            "strawberry-graphql",
            "async-graphql",
            "com.graphql-java:*",
            "github.com/99designs/gqlgen",
        ],
        files: &[],
    },
    TagRule {
        tag: "db:postgres",
        label: "PostgreSQL",
        basis: TagBasis::Manifest,
        dependencies: &[
            "pg",
            "postgres",
            "tokio-postgres",
            "psycopg",
            "psycopg2",
            "psycopg2-binary",
            "asyncpg",
            "org.postgresql:*",
            "github.com/lib/pq",
            "github.com/jackc/pgx*",
        ],
        files: &[],
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
    ("lang:php", "PHP"),
    ("lang:scala", "Scala"),
    ("lang:shell", "Shell"),
    ("lang:hcl", "HCL"),
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
    if tag == "lang:shell" {
        "contains shell scripts".into()
    } else if tag.starts_with("lang:") {
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

/// Simple `*` wildcard match, linear time, no regex. Runs for every dependency
/// against every rule, so it does not allocate.
pub fn wildcard_match(pattern: &str, value: &str) -> bool {
    let Some((first, mut parts)) = pattern.split_once('*') else {
        return pattern == value;
    };
    let Some(mut rest) = value.strip_prefix(first) else {
        return false;
    };
    while let Some((part, more)) = parts.split_once('*') {
        match rest.split_once(part) {
            Some((_, after)) => rest = after,
            None => return false,
        }
        parts = more;
    }
    rest.ends_with(parts)
}

/// Directories whose code serves the project rather than being it.
const CHORE_DIRS: &[&str] = &[
    "scripts",
    "script",
    "tools",
    "tool",
    "hack",
    "bin",
    "ci",
    ".ci",
    ".github",
    ".gitlab",
    "docs",
    "doc",
    "misc",
    "third_party",
    "thirdparty",
    "static",
    "public",
    "assets",
    "resources",
    "webapp",
    "buildSrc",
    "build-logic",
    "fixtures",
    "__fixtures__",
    "testdata",
];

/// Files of a tool's own configuration or a copied library, written in a language
/// the project need not be: `karma.conf.js`, `vite.config.ts`, `jquery.min.js`.
fn is_chore_file(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with(".min.js")
        || name.ends_with(".conf.js")
        || name.starts_with("webpack.")
        || name.eq_ignore_ascii_case("gulpfile.js")
        || name.eq_ignore_ascii_case("gruntfile.js")
        || name.contains(".config.")
}

fn is_chore(path: &str) -> bool {
    let (dirs, name) = path.rsplit_once('/').unwrap_or(("", path));
    is_chore_file(name) || dirs.split('/').any(|d| CHORE_DIRS.contains(&d))
}

/// Whether a module's manifest says it is written in `lang`.
fn owned_by(ecosystem: Ecosystem, lang: &str) -> bool {
    match ecosystem {
        Ecosystem::Maven | Ecosystem::Gradle => {
            matches!(lang, "lang:java" | "lang:kotlin" | "lang:scala")
        }
        Ecosystem::Npm => matches!(lang, "lang:javascript" | "lang:typescript"),
        other => other.language() == lang,
    }
}

/// How much of a language a module holds, its example first.
struct LanguageCount {
    example: String,
    count: u32,
    /// Files outside the chore directories.
    core: u32,
}

/// Whether a language is true of a module without saying what it is for: no
/// manifest of its own, another language has more real code here, and this one
/// lives in chores or is under a tenth of the module. A rule that a skill's
/// author wrote still sees it; Habi does not suggest a skill on its strength.
fn incidental(this: &LanguageCount, total: u32, others: u32, owned: bool) -> bool {
    !(owned && this.core > 0)
        && others > this.core
        && (this.core == 0 || this.core.saturating_mul(10) < total)
}

/// Adds derived tag facts based on dependency and file facts.
pub fn derive(
    out: &mut Collector,
    files: &[(String, u64)],
    module_of: &dyn Fn(&str) -> String,
    ecosystems: &BTreeMap<String, BTreeSet<Ecosystem>>,
) {
    let mut hits: Vec<(String, &'static str, String)> = Vec::new();
    for fact in &out.facts {
        for rule in TAG_RULES {
            let hit = match &fact.subject {
                FactSubject::Dependency { name, .. } => {
                    rule.dependencies.iter().any(|p| wildcard_match(p, name))
                }
                FactSubject::File { role, .. } => rule.files.contains(&role.as_str()),
                FactSubject::Tag { .. } => false,
            };
            if hit {
                hits.push((fact.module.clone(), rule.tag, fact.id.clone()));
            }
        }
    }
    for (module, tag, id) in &hits {
        out.tag(module, tag, id);
    }

    // Languages: count source files per module.
    let mut first: BTreeMap<(String, &'static str), LanguageCount> = Default::default();
    // A skill's scripts are not the project's code.
    for (path, _) in files
        .iter()
        .filter(|(p, _)| !super::files::inside_skill_package(p) && !super::files::in_fixture(p))
    {
        if let Some(lang) = super::files::language_of(path) {
            let entry = first
                .entry((module_of(path), lang))
                .or_insert_with(|| LanguageCount {
                    example: path.clone(),
                    count: 0,
                    core: 0,
                });
            entry.count += 1;
            if !is_chore(path) {
                entry.core += 1;
            }
        }
    }
    for ((module, lang), this) in &first {
        let peers = || {
            first
                .range((module.clone(), "")..)
                .take_while(|((m, _), _)| m == module)
        };
        let total = peers().map(|(_, c)| c.count).sum();
        let others = peers()
            .filter(|((_, l), _)| l != lang)
            .map(|(_, c)| c.core)
            .max()
            .unwrap_or(0);
        let owned = ecosystems
            .get(module)
            .is_some_and(|set| set.iter().any(|e| owned_by(*e, lang)));
        out.language(
            module,
            lang,
            &this.example,
            this.count,
            incidental(this, total, others, owned),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chores_are_told_from_code() {
        for path in [
            "scripts/seed.py",
            "tools/dash/main.go",
            "src/main/resources/static/js/app.js",
            "karma.conf.js",
            "web/vite.config.ts",
            ".eslintrc.js",
            "buildSrc/src/main/kotlin/A.kt",
            "docs/theme/custom.js",
        ] {
            assert!(is_chore(path), "{path}");
        }
        for path in ["src/main.ts", "app/models.py", "api/handler.go", "build.py"] {
            assert!(!is_chore(path), "{path}");
        }
    }

    #[test]
    fn a_language_is_incidental_only_beside_more_real_code() {
        let of = |core| LanguageCount {
            example: String::new(),
            count: core,
            core,
        };
        // One Python script among forty Java files.
        assert!(incidental(&of(0), 41, 40, false));
        assert!(incidental(&of(1), 41, 40, false));
        // The only language there is, however it is laid out.
        assert!(!incidental(&of(0), 3, 0, false));
        // A real share of the module.
        assert!(!incidental(&of(10), 50, 40, false));
        // Its own manifest says it belongs here.
        assert!(!incidental(&of(1), 41, 40, true));
        // A manifest does not make build scripts the project's language.
        assert!(incidental(&of(0), 41, 40, true));
    }

    #[test]
    fn product_dependencies_mean_the_product() {
        let tagged = |tag: &str, dependency: &str| {
            rule(tag).is_some_and(|r| r.dependencies.iter().any(|p| wildcard_match(p, dependency)))
        };
        assert!(tagged("cloud:vercel", "@vercel/analytics"));
        assert!(!tagged("cloud:vercel", "@vercel/ncc"));
        assert!(tagged("cloud:azure", "azure-storage-blob"));
        assert!(tagged("cloud:azure", "azure_core"));
        assert!(!tagged("cloud:azure", "azure-pipelines-task-lib"));
        assert!(!tagged("cloud:azure", "azure-devops-node-api"));
    }

    /// The window keeps its own names for tags, so it never shows a raw one.
    #[test]
    fn the_desktop_app_has_a_name_for_every_tag() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/src/lib/tags.ts"
        );
        let labels = std::fs::read_to_string(path).unwrap();
        for tag in TAG_RULES
            .iter()
            .map(|r| r.tag)
            .chain(LANGUAGE_TAGS.iter().map(|(t, _)| *t))
            .filter(|t| !t.starts_with("agents:"))
        {
            assert!(
                labels.contains(&format!("\"{tag}\":")),
                "{tag} has no name in tags.ts"
            );
        }
    }

    #[test]
    fn wildcards() {
        assert!(wildcard_match("org.jooq:*", "org.jooq:jooq"));
        assert!(!wildcard_match("org.jooq:*", "org.jooqx:jooq"));
        assert!(wildcard_match("*-starter-*", "spring-boot-starter-web"));
        assert!(wildcard_match("react", "react"));
        assert!(!wildcard_match("react", "react-dom"));
    }
}
