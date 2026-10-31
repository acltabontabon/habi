# Detectors

What can Habi establish as conditions in `habi.yaml`? This page lists what inspection finds.

**Inspection is read-only:** lists files (respecting `.gitignore`, `.ignore`, `.habiignore` and
`.git/info/exclude`), reads build manifests and config files, parses source for
[imports and annotations](#source-code), and never runs code, builds, Git,
hooks, or package managers. Ignore files above the repository root are not honoured, and one that
cannot be applied is reported, so the result says it may not have seen everything.
READMEs are never inspected as evidence.

## What's skipped

**Always:**
`.git`, `node_modules`, `.gradle`, `.idea`, `.venv`, `__pycache__`, `.next`, `.nuxt`,
`.svelte-kit`, `.turbo`, `.cache`, `.yarn`, `.terraform`, `.terragrunt-cache`, `.databricks`,
`.angular`, `.nx`, `.tox`, `.pytest_cache`, `site-packages`, `cdk.out`, etc. Credential stores
(`.ssh`, `.aws`, `.azure`, `.kube`, `.gnupg`) are skipped too, should a project hold one.

**As build output (root or under a manifest only):**
`target`, `build`, `dist`, `out`, `vendor`, `venv`, `coverage` (same names appear as code;
limited to build contexts to avoid false negatives). A repository root with no build manifest
keeps `build`, `out` and `vendor`: there they hold sources, such as `build/Dockerfile`.

**Secret files (never read or indexed):**
`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `*.tfvars`, `*.tfstate*`, `*.tfplan`,
`.databrickscfg`, `.terraformrc`, `.pypirc`, `.vault-token`, `vault.yml`, `secrets.yaml`,
`*-secrets.yaml`, `values-secret*`, `*.sops.yaml`, `.docker/config.json`, etc.

**What is kept is safe to show:** a credential inside a manifest (a token in a dependency URL, a
password in a README's first paragraph) is redacted before it reaches a fact, a version, a note or
the project's description. A dependency given as a URL where a coordinate belongs is not read,
and the module's coverage says so.

**Test inputs:** a manifest or recognized file in `fixtures`, `testdata`, `src/test/resources`,
`src/it` or `archetype-resources` is a sample project, not a module of this one.

**Symbolic links:** never followed (counted in report)

## Scan limits

| Limit | Impact |
|-------|--------|
| 50,000 files | Incomplete scan if exceeded. Build manifests and project markers past it stay listed (up to 5,000), so a tree of data cannot hide the project; the walk stops at 400,000 entries |
| Depth 24 | Incomplete scan if exceeded |
| Manifests 2 MiB | Bounded parsing |
| Lockfiles 48 MiB | Bounded parsing |
| 5,000 content probes | First 4 KiB of YAML/JSON/XML/SQL files (build manifests, lockfiles and Helm templates never probed); first 64 bytes of `.py`, `.scala` and `.r` files in a notebook or Databricks folder |

**Incomplete scan** → absence-based conditions (files, language, CI, containers) become *unknown*

**Partial content coverage** → absence of content-recognized tags (`api:openapi`, `db:liquibase`,
`infra:kubernetes`, `data:databricks`) becomes *unknown*

## Source code

Habi parses source files and keeps two things from them: imported names and annotation names, each
with its file and first line. No other source text is stored, shown or logged.

| Language | Imports | Annotations |
|---|---|---|
| **Java**, **Kotlin** | `import` | `@Annotation` |
| **JavaScript**, **TypeScript** | `import`, `export … from`, `require()`, `import()`, `import x = require()` | Decorators |
| **Python** | `import`, `from … import` | Decorators |
| **Go** | `import` | |
| **Rust** | `use`, `extern crate`, paths such as `serde_json::from_str` | Attributes, and the names in `#[derive()]` |
| **PHP** | `use` | `#[Attribute]` |

Local paths (`./x`, `@/x`, Rust's `crate::`, Python's `from .x`) and URLs are not kept. Nor is anything
in a fixture or an installed skill, a `.d.ts` file, a Gradle script, or a minified or binary file.

C# and Scala have no grammar in Habi. A rule that names no language is *unknown* in a module that holds
them, because the name could be there.

| Limit | Impact |
|-------|--------|
| 30,000 source files | Files past it are not read |
| 1 MiB per file | A larger file is not read |
| 512 MiB per inspection | Files past it are not read |
| 1 second per file, 30 seconds per inspection | A file past its time is not read; the next inspection continues, because what was read is remembered while Habi runs |

**Source not fully read** → absence of a [`code` condition](metadata-schema.md#conditions) becomes
*unknown*. Finding a name is still *true*.

**A declared dependency's reason says where it is used** (`imported in src/App.java:5 and 12 more
files`) when its name says how it is imported: npm, Go, Cargo, PyPI (a few packages import under
another name, and Habi knows the common ones), and Maven or Gradle where the artifact names its package.
A framework or tool on the JVM cites its own packages, whichever dependency brought it in: JUnit cites
`org.junit`, never another import from the group of the starter that brought it. Composer names say
nothing about namespaces, so they cite nothing, and neither does a name Habi cannot tie to a package.
This is only evidence: finding no import does not change whether a dependency counts, because plugins
and runtimes are not imported.

## Module discovery

**What's a module?** Any directory with a build manifest:
`pom.xml`, `build.gradle(.kts)`, `package.json`, `go.mod`, `Cargo.toml`, `composer.json`,
`pyproject.toml`, `Pipfile`, `requirements*.txt`, `*-requirements.txt`, `setup.py`. A `requirements/`
folder belongs to the module above it. `buildSrc` and `build-logic` are a build's tooling, at any
depth, and never modules.

The root is always a module. Files belong to the deepest module.

**Scope inheritance:**
- Conditions with `scope: module` evaluate per module (a backend skill doesn't apply to a
  whole monorepo just because one service uses it)
- **Repository-level facts** (CI, agent instructions, Dockerfiles, MCP, build wrappers and
  derived tags) inherited from root and parent modules
- Dependencies & manifest-derived tags are NOT inherited (Maven parents, Gradle subprojects
  handled per-detector)
- `file:` patterns limited to the module's own files

**User declarations:**
- Per-module only; don't affect other modules
- In `scope: repository` eval: "absent" doesn't hide facts elsewhere; "present" establishes
  it for the whole repository

## Maven (`pom.xml`)

- Dependencies, `dependencyManagement`, build plugins, profiles, `<modules>`. An imported BOM
  counts as a dependency (it is a choice of platform); a managed version alone does not.
- `${…}` properties resolve through the POM and **local** parents (`relativePath`, default
  `../pom.xml`). Undefined properties → version *unresolved*, with the property named.
- Missing versions resolve from local `dependencyManagement`; otherwise *managed by* the
  external parent or imported BOM.
- External parents make Maven coverage **partial** (their dependencies are invisible), except
  `spring-boot-starter-parent` / `spring-boot-dependencies`, which only manage versions.
- DTDs are rejected; node count is bounded.

## Gradle (`build.gradle`, `build.gradle.kts`, `settings.gradle(.kts)`, `gradle/libs.versions.toml`)

- Each build has its own settings, catalog and conventions: `backend/settings.gradle` and
  `backend/gradle/libs.versions.toml` serve the projects below `backend/`.
- Plugins (`id(...)`, `kotlin(...)`, core plugins, `alias(libs.plugins…)`, `apply plugin`).
  A plugin declared `apply false` is applied elsewhere and says nothing of this project.
- Dependencies in string, map and version-catalog forms (`libs.x.y`, bundles), `kotlin("test")`,
  and `mavenBom` imports. Entries in `dependencyManagement { dependencies {} }` only manage versions.
- `subprojects {}` / `allprojects {}` dependencies and `apply plugin` lines are attributed
  to the modules they apply to (inherited, with the root script as evidence).
- Declarations sharing a line with block braces (`plugins { id("x") version "1" }`,
  `dependencies { implementation("g:a:1") }`) are read in the block they belong to; braces
  inside string literals do not open blocks.
- Coverage becomes **partial** when Habi sees: `apply from`, `configure(...)`, conditional or
  computed declarations, unrecognized dependency or plugin declaration forms, or convention
  plugins from `buildSrc`/included builds. The reasons are listed in the Evidence view.
- Dynamic versions (`+`, ranges, `latest.*`) are *ranges*; `$var` versions are *unresolved*.

## npm (`package.json`, `package-lock.json`, `pnpm-lock.yaml`)

- `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `workspaces`.
- A declared range (`^18.2.0`) is **not** a runtime version. Concrete versions come from
  `package-lock.json` (v2/v3) or `pnpm-lock.yaml` importers, or an exact pin. `yarn.lock`
  is not parsed (versions stay ranges).

## Go (`go.mod`)

- The module path (its last segment names the module) and `require` entries, single-line
  and block. Versions in `go.mod` are exact, so every requirement is *resolved*;
  `// indirect` requirements are kept, with that scope. `replace` and `exclude` are not
  followed.

## Rust (`Cargo.toml`, `Cargo.lock`)

- `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and their
  `[target.*]` forms; a renamed crate (`package = "…"`) matches by its real name.
- Workspaces: a member's `dep = { workspace = true }` takes its requirement from the root's
  `[workspace.dependencies]`. A requirement (`1.0`) is a *range*; the nearest `Cargo.lock`
  pins the built version. Path and Git dependencies have no version.

## Python (`pyproject.toml`, `requirements*.txt`, `Pipfile`, `uv.lock`, `poetry.lock`, `Pipfile.lock`)

- PEP 621 `[project] dependencies` and `optional-dependencies`, PEP 735
  `[dependency-groups]`, Poetry `[tool.poetry.dependencies]` and groups, `Pipfile`
  packages, and requirement files (`-r`, `-e`, URLs and options are skipped).
- Names are compared normalized (PEP 503): `Great_Expectations` is `great-expectations`.
  `==` pins are *resolved*; other specifiers are *ranges* until `uv.lock`, `poetry.lock`
  or `Pipfile.lock` pins them. `setup.py` marks a module but is not executed or parsed.

## PHP (`composer.json`, `composer.lock`)

- `require` and `require-dev`; platform requirements (`php`, `ext-*`, `lib-*`) are left
  out. Constraints are *ranges* until the `composer.lock` beside the manifest pins them.

A project's languages come from its source files. Before any is seen (a fresh `go.mod`),
its colors in Habi fall back to the language of its build files; `lang:` conditions do not.

## Recognized files

| Role | How |
|---|---|
| OpenAPI specification | YAML/JSON whose first 4 KiB contains a top-level `openapi: 3.x` / `swagger: "2.0"` |
| Liquibase changelog | `<databaseChangeLog`, `databaseChangeLog:` or `--liquibase formatted sql` |
| Flyway migration | `**/db/migration/V*__*.sql` |
| Agent instructions | `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.claude/rules/**`, `.cursor/rules/**/*.mdc`, `.cursorrules`, `.github/copilot-instructions.md` |
| Agent skills | `SKILL.md` one folder deep in `.claude/skills`, `.agents/skills`, `.cursor/skills`, `.gemini/skills`, `.github/skills`, `.opencode/skills` and `.junie/skills` |
| MCP config | `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`, `.junie/mcp/mcp.json` |
| Tooling | `tsconfig.json`, Jest/Vitest/Playwright/Cypress configs, `*.bats`, GitHub Actions, GitLab CI, Dockerfile, `mvnw`/`gradlew`, `dbt_project.yml` |
| Infrastructure | `*.tf`, `.terraform.lock.hcl`, `terragrunt.hcl`, `Chart.yaml`, `helmfile.yaml`, `kustomization.yaml`, `ansible.cfg`, `playbook.yml`, `playbooks/*.yml`, `roles/*/tasks/main.yml`, `Pulumi.yaml` |
| Kubernetes manifest | YAML whose first 4 KiB has top-level `apiVersion:` and `kind:` |
| Databricks | `databricks.yml`, or a notebook file starting `# Databricks notebook source` |
| Test automation | `specs/*.spec`, `*.cpt` (Gauge), `*.robot`, `*.feature`, `testng.xml`, `*.jmx`, `karma.conf.*`, `*.postman_collection.json` |
| Other | `*.ipynb` (Jupyter), `META-INF/native-image/**` (GraalVM) |

A role a project can hold thousands of files in records the first per module.

## Derived tags

Defined in `crates/habi-core/src/inspect/tags.rs`, each with its evidence basis
(manifest, files or both):

`framework:spring-boot · spring · spring-security · spring-batch · spring-cloud · quarkus · micronaut · react · vue · angular · next · svelte · express · nestjs`,
`runtime:graalvm`, `build:vite`, `test:junit · testcontainers · jest · vitest · playwright · cypress · bats ·
gauge · robot-framework · cucumber · selenium · testng · spock · mockito · rest-assured · karate · gatling ·
jmeter · k6 · locust · karma · jasmine · mocha · webdriverio · appium · pact · wiremock · postman`,
`db:liquibase · flyway · jooq`, `orm:jpa`, `api:openapi` (a specification, or a tool that generates from or publishes one, such as `openapi-generator` or `@nestjs/swagger`) `· springdoc`,
`ci:github-actions · gitlab`, `container:docker`,
Go `framework:gin · echo · fiber · wails`, `orm:gorm`;
Rust `framework:axum · actix · tauri · tokio`, `orm:diesel`, `db:sqlx`;
Python `framework:django · flask · fastapi`, `orm:sqlalchemy`, `test:pytest`;
PHP `framework:laravel · symfony`, `orm:doctrine`, `test:phpunit`;
data engineering `data:dbt` (also from `dbt_project.yml`) `· airflow · dagster · prefect ·
spark · beam · kafka · great-expectations · pandas · polars · duckdb · databricks · delta · mlflow ·
jupyter`,
where it runs and what it talks to `cloud:azure · aws · gcp · cloudflare · vercel` (Cloudflare and Vercel also from `wrangler.*` and `vercel.json`), `sdk:twilio · stripe · firebase · supabase · sentry · openai · mcp`, `framework:react-native · tailwind`, `api:graphql`, `db:postgres`;
infrastructure `infra:terraform · terragrunt · helm · kubernetes · kustomize · ansible · pulumi`,
`agents:agents-md · claude-md · cursor-rules · skills`,
and languages from source extensions: `lang:java · kotlin · typescript · javascript · python · go · rust · csharp · php · scala · shell · hcl`.

A language can be *incidental*: no manifest of its own, more real code in another language beside
it, and all its files in chores (`scripts/`, `tools/`, `docs/`, `resources/`, tool configs) or under
a tenth of the module. It stays true, so a rule an author wrote still holds. A rule Habi supplied
(what a skill's description names, a catalog hint or pick) does not count it, so one script in a
Java service does not suggest Python skills.

A tag Habi cannot detect (e.g. a team-specific `team:payments`) is always *unknown* until
the user declares it for the project.

## Provenance

Every fact records its detector, module, evidence file and line, a short non-sensitive
excerpt (a coordinate, never file bodies), and its origin: read directly, derived, inherited
from a local parent, or declared by the user. The project fingerprint includes manifest and
lockfile digests plus indexed file paths, sizes and modification times. Source bodies are
not hashed. Check results tied to an older fingerprint are shown as out of date, including
after a same-size source edit with a changed modification time.

Evidence uses the latest completed result for each declared check and applicable module,
independently of the limited recent-run history. A pass cannot hide a different failure or
an unchecked pair; incomplete scan coverage keeps passing evidence partially checked.
Cancellation preserves the previous completed result. Ignored files, environment changes,
external services and content edits that preserve size and modification time are outside
this freshness signal.

Inspections are cached per project. Before a cached inspection is reused, Habi compares the
size and modification time of every indexed file, ignore file, `.git/HEAD` and every
listed directory (up to 20 000) with what it saw; any difference — an edit, a branch switch,
a file added or removed — triggers a new inspection. Applying a plan (install, update,
removal, restore) or recovering an interrupted one also drops the cached inspection.
An ordinary content edit to an indexed file also triggers inspection, including turning an
existing YAML file into an OpenAPI document.

Versions are compared leniently: `3.2.0.RELEASE` is `3.2.0`. Only recognized pre-release
markers (`alpha`, `beta`, `rc`, `cr`, `M1`/`milestone`, `SNAPSHOT`, `preview`, `ea`, `dev`,
any case) make a pre-release; other qualifiers (`32.1.3-jre`, `-android`, `.Final`) are
ignored, so `32.1.3-jre` satisfies `>=31`.

## Adding a detector

Detectors are plain functions that read inputs and call `Collector` (`dependency`, `file`,
`tag`, `coverage`). Add the parser module under `inspect/`, call it from `inspect::inspect`,
record coverage honestly (`Partial` with a reason whenever something is not evaluated), add
tag rules if useful, and add fixtures with misleading inputs to the tests.
