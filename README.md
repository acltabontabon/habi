<div align="center">

# Habi

**Find what applies. Improve what works. Share what you learn.**

Habi is a local desktop app for the skills and instructions you give AI coding agents.<br>Open a repository and Habi shows which skills fit it, and why, down to the file and line.

<a href="https://github.com/acltabontabon/habi/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/acltabontabon/habi?style=flat-square&labelColor=1f1c19&color=d9913f"></a> <a href="https://github.com/acltabontabon/habi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/acltabontabon/habi/ci.yml?branch=main&style=flat-square&labelColor=1f1c19&color=d9913f&label=CI"></a> <img alt="Platforms: macOS and Windows" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows-d9913f?style=flat-square&labelColor=1f1c19"> <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-d9913f?style=flat-square&labelColor=1f1c19"></a>

<a href="https://github.com/acltabontabon/habi/releases/latest"><b>Download</b></a> &nbsp;·&nbsp; <a href="https://acltabontabon.com/habi/docs/">Documentation</a> &nbsp;·&nbsp; <a href="https://acltabontabon.com/habi/">Website</a>

<a href="https://acltabontabon.com/habi/#demo"><img src="docs/media/demo.gif" alt="The Habi film: skills stuck on one laptop, fixes that never come back, no idea what fits; then Habi shows what fits a repo and why, gathers the builders', the community's and your team's libraries, installs for seven agents, sends fixes back as pull requests, and every project updates." width="86%"></a>

</div>

## What it does

- **Find** skills that fit your repo, each with the files and lines behind it. Nothing is built or run.
- **Install** them for your agents, after previewing every file.
- **Edit** a copy locally: the full package with instructions, scripts, references and assets.
- **Share** improvements back to a library as a pull or merge request, after seeing exactly what leaves your machine.
- **Update** what you installed, in a project or on your machine, after seeing exactly what changed.
- **Trust** what you see: every skill shows its author, license and origin. No account, telemetry, cloud service or model call.

Skills are ordinary [Agent Skills](https://agentskills.io) folders and shared instructions go
into `AGENTS.md`, so everything keeps working without Habi. Git uses your existing credentials.

## Supported agents

Habi writes to the folders each agent already reads, and installs as few copies as it can.

| Agent | Skills | Instructions | MCP servers |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `CLAUDE.md`, importing `AGENTS.md` | `.mcp.json` |
| Cursor | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `.cursor/mcp.json` |
| Codex | `.agents/skills/` | `AGENTS.md` | `.codex/config.toml` |
| Gemini CLI | `.agents/skills/` | `GEMINI.md`, importing `AGENTS.md` | `.gemini/settings.json` |
| GitHub Copilot | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `.mcp.json` |
| OpenCode | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `opencode.json` |
| Junie | `.agents/skills/` | `AGENTS.md` | `.junie/mcp/mcp.json` |

Skills can also go in the same folders under your home folder, for all your projects. See
[Agent tools](docs/guide/agent-tools.md) for the details and what isn't supported.

## Supported technology

Habi reads these from a repository's manifests and files, without running anything, and matches
skills to them. [Detectors](docs/library-authors/detectors.md) has every rule.

| Area | Recognized |
|---|---|
| Languages | Java, Kotlin, TypeScript, JavaScript, Python, Go, Rust, C#, PHP, Scala, shell, HCL |
| Build and packages | Maven, Gradle, npm, pnpm, Go modules, Cargo, pip, Poetry, uv, Pipenv, Composer |
| Java and Kotlin | Spring Boot, Spring, Spring Security, Spring Batch, Spring Cloud, Quarkus, Micronaut, GraalVM |
| JavaScript and TypeScript | React, Vue, Angular, Next.js, Svelte, Vite, Express, NestJS |
| Go | Gin, Echo, Fiber, Wails |
| Rust | Axum, Actix, Tauri, Tokio |
| Python | Django, Flask, FastAPI |
| PHP | Laravel, Symfony |
| Databases and APIs | Liquibase, Flyway, jOOQ, JPA, GORM, Diesel, SQLx, SQLAlchemy, Doctrine, OpenAPI, springdoc |
| Data | dbt, Airflow, Dagster, Prefect, Spark, Beam, Kafka, Great Expectations, pandas, Polars, DuckDB, Databricks, Delta Lake, MLflow, Jupyter |
| Infrastructure and CI | Docker, GitHub Actions, GitLab CI, Terraform, Terragrunt, Helm, Kubernetes, Kustomize, Ansible, Pulumi |
| Testing | JUnit, Testcontainers, Jest, Vitest, Playwright, Cypress, pytest, PHPUnit, Bats, Gauge, Robot Framework, Cucumber, Selenium, TestNG, Spock, Mockito, REST Assured, Karate, Gatling, JMeter, k6, Locust, Karma, Jasmine, Mocha, WebdriverIO, Appium, Pact, WireMock, Postman |

## Install

<p align="center">
<a href="https://github.com/acltabontabon/habi/releases/latest"><img alt="Download for macOS" src="https://img.shields.io/badge/Download%20for%20macOS-d9913f?style=for-the-badge&logo=apple&logoColor=white"></a>
&nbsp;
<a href="https://github.com/acltabontabon/habi/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download%20for%20Windows-d9913f?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0wIDMuNCA5LjggMnY5LjVIMHpNMTEgMS44IDI0IDB2MTEuNUgxMXpNMCAxMi41aDkuOFYyMkwwIDIwLjZ6TTExIDEyLjVoMTNWMjRsLTEzLTEuOHoiLz48L3N2Zz4%3D"></a>
<br>
<sub>macOS 11 or later, Apple Silicon and Intel &nbsp;·&nbsp; Windows 64-bit</sub>
</p>

Or on macOS, with Homebrew:

```sh
brew install --cask acltabontabon/tap/habi
```

The first launch asks you to confirm once, because the installers are not signed by Apple or
Microsoft ([how](docs/guide/getting-started.md#installing)). Updates after that are signed with
Habi's own key.

## A look inside

<table>
<tr>
<td width="50%" valign="top"><img src="docs/media/suggested.jpg" alt="Suggested skills for a project: each with the reason it fits and about how many tokens it costs, and a card to review and add them." width="100%"><br><b>Suggested, for every project</b><br><sub>A short list for this repository, each with its reason and what it costs in context.</sub></td>
<td width="50%" valign="top"><img src="docs/media/project.jpg" alt="A project in Habi: skills grouped by whether they are installed, required by the team or fit, with the files and lines that explain why one fits." width="100%"><br><b>Fits, and why</b><br><sub>Every skill matched to the repository, with the files and lines behind it.</sub></td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/media/install-review.jpg" alt="The install dialog: seven agent tools to choose from and the three files that will change." width="100%"><br><b>See every file first</b><br><sub>Nothing is written until you say so.</sub></td>
<td width="50%" valign="top"><img src="docs/media/share-review.jpg" alt="Sharing a skill: the files that leave your machine, as a diff, and the checks that ran." width="100%"><br><b>Send it back</b><br><sub>Preview what leaves your machine, then open a pull request.</sub></td>
</tr>
</table>
