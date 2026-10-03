# Detectors

What can Habi establish as conditions in `habi.yaml`? This page lists what inspection finds.

**Inspection is read-only:** lists files (respecting `.gitignore`, `.habiignore`), reads build
manifests and config files, and never runs code, builds, Git, hooks, or package managers.
READMEs are never inspected as evidence.

## What's skipped

**Always:**
`.git`, `node_modules`, `.gradle`, `.idea`, `.venv`, `__pycache__`, `.next`, `.nuxt`,
`.svelte-kit`, `.turbo`, `.cache`, `.yarn`, `.terraform`, etc.

**As build output (root or under a manifest only):**
`target`, `build`, `dist`, `out`, `vendor`, `venv`, `coverage` (same names appear as code;
limited to build contexts to avoid false negatives)

**Secret files (never read or indexed):**
`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, etc.

**Symbolic links:** never followed (counted in report)

## Scan limits

| Limit | Impact |
|-------|--------|
| 50,000 files | Incomplete scan if exceeded |
| Depth 24 | Incomplete scan if exceeded |
| Manifests 2 MiB | Bounded parsing |
| Lockfiles 48 MiB | Bounded parsing |
| 600 content probes | First 4 KiB of YAML/JSON/XML/SQL files (build manifests/lockfiles never probed) |

**Incomplete scan** → absence-based conditions (files, language, CI, containers) become *unknown*

**Partial content coverage** → absence of content-recognized tags (`api:openapi`, `db:liquibase`)
becomes *unknown*

## Module discovery

**What's a module?** Any directory with a build manifest:
`pom.xml`, `build.gradle(.kts)`, `package.json`, `go.mod`, `Cargo.toml`, `composer.json`,
`pyproject.toml`, `Pipfile`, `requirements*.txt`, `setup.py`

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

- Dependencies, `dependencyManagement`, build plugins, profiles, `<modules>`.
- `${…}` properties resolve through the POM and **local** parents (`relativePath`, default
  `../pom.xml`). Undefined properties → version *unresolved*, with the property named.
- Missing versions resolve from local `dependencyManagement`; otherwise *managed by* the
  external parent or imported BOM.
- External parents make Maven coverage **partial** (their dependencies are invisible), except
  `spring-boot-starter-parent` / `spring-boot-dependencies`, which only manage versions.
- DTDs are rejected; node count is bounded.

## Gradle (`build.gradle`, `build.gradle.kts`, `settings.gradle(.kts)`, `gradle/libs.versions.toml`)

- Plugins (`id(...)`, `kotlin(...)`, core plugins, `alias(libs.plugins…)`, `apply plugin`).
- Dependencies in string, map and version-catalog forms (`libs.x.y`, bundles).
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
| Tooling | `tsconfig.json`, Jest/Vitest/Playwright/Cypress configs, GitHub Actions, GitLab CI, Dockerfile, `mvnw`/`gradlew`, `dbt_project.yml` |

## Derived tags

Defined in `crates/habi-core/src/inspect/tags.rs`, each with its evidence basis
(manifest, files or both):

`framework:spring-boot · quarkus · micronaut · react · vue · angular · next · svelte · express · nestjs`,
`build:vite`, `test:junit · testcontainers · jest · vitest · playwright · cypress`,
`db:liquibase · flyway · jooq`, `orm:jpa`, `api:openapi · springdoc`,
`ci:github-actions · gitlab`, `container:docker`,
Go `framework:gin · echo · fiber · wails`, `orm:gorm`;
Rust `framework:axum · actix · tauri · tokio`, `orm:diesel`, `db:sqlx`;
Python `framework:django · flask · fastapi`, `orm:sqlalchemy`, `test:pytest`;
PHP `framework:laravel · symfony`, `orm:doctrine`, `test:phpunit`;
data engineering `data:dbt` (also from `dbt_project.yml`) `· airflow · dagster · prefect ·
spark · beam · kafka · great-expectations · pandas · polars · duckdb`,
`agents:agents-md · claude-md · cursor-rules · skills`,
and languages from source extensions: `lang:java · kotlin · typescript · javascript · python · go · rust · csharp · php`.

A tag Habi cannot detect (e.g. a team-specific `team:payments`) is always *unknown* until
the user declares it for the project.

## Provenance

Every fact records its detector, module, evidence file and line, a short non-sensitive
excerpt (a coordinate, never file bodies), and its origin: read directly, derived, inherited
from a local parent, or declared by the user. The project fingerprint (manifest and lockfile
digests plus the file listing) changes when relevant files change; check results tied to an
older fingerprint are shown as out of date.

Inspections are cached per project. Before a cached inspection is reused, Habi compares the
size and modification time of every manifest, lockfile, ignore file, `.git/HEAD` and every
listed directory (up to 20 000) with what it saw; any difference — an edit, a branch switch,
a file added or removed — triggers a new inspection. Applying a plan (install, update,
removal, restore) or recovering an interrupted one also drops the cached inspection. An
in-place edit of an unrecognized file's content (for example turning an existing YAML file
into an OpenAPI document) is only seen after a rescan.

Versions are compared leniently: `3.2.0.RELEASE` is `3.2.0`. Only recognized pre-release
markers (`alpha`, `beta`, `rc`, `cr`, `M1`/`milestone`, `SNAPSHOT`, `preview`, `ea`, `dev`,
any case) make a pre-release; other qualifiers (`32.1.3-jre`, `-android`, `.Final`) are
ignored, so `32.1.3-jre` satisfies `>=31`.

## Adding a detector

Detectors are plain functions that read inputs and call `Collector` (`dependency`, `file`,
`tag`, `coverage`). Add the parser module under `inspect/`, call it from `inspect::inspect`,
record coverage honestly (`Partial` with a reason whenever something is not evaluated), add
tag rules if useful, and add fixtures with misleading inputs to the tests.
