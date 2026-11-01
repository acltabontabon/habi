<div align="center">

# Habi

**Find what applies. Improve what works. Share what you learn.**

Habi is a local desktop app for the skills and instructions you give AI coding agents.<br>Open a repository and Habi shows which skills fit it, and why, down to the file and line.

<a href="https://github.com/acltabontabon/habi/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/acltabontabon/habi?style=flat-square&labelColor=1f1c19&color=d9913f"></a> <img alt="Platforms: macOS and Windows" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows-d9913f?style=flat-square&labelColor=1f1c19"> <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-d9913f?style=flat-square&labelColor=1f1c19"></a>

<a href="https://acltabontabon.com/habi/docs/">Documentation</a> &nbsp;·&nbsp; <a href="https://acltabontabon.com/habi/">Website</a>

<a href="https://acltabontabon.com/habi/#demo"><img src="docs/media/demo.gif" alt="The Habi film: skills stuck on one laptop, fixes that never come back, no idea what fits; then Habi shows what fits a repo and why, gathers the builders', the community's and your team's libraries, installs for seven agents, sends fixes back as pull requests, and every project updates." width="86%"></a>

</div>

## What it does

- **Find** skills that fit your repo, with the files and lines behind each one.
- **Install** them for your agents, after previewing every file.
- **Improve** your own copy, and update it when the library changes.
- **Share** your fixes back as a pull or merge request.

No account, telemetry, cloud service or model call, and nothing in your repo is run. Skills are
ordinary files, so they keep working without Habi.

## Install

| Platform | Requires | Get it |
|---|---|---|
| <img src="docs/media/icon-apple.svg" width="16" height="16" alt=""> **macOS** | 11 or later, Apple Silicon or Intel | [Download](https://github.com/acltabontabon/habi/releases/latest)<br>or `brew install --cask acltabontabon/tap/habi` |
| <img src="docs/media/icon-windows.svg" width="16" height="16" alt=""> **Windows** | 64-bit | [Download](https://github.com/acltabontabon/habi/releases/latest) |

<details>
<summary><b>First launch</b> &nbsp;<sub>you confirm once</sub></summary>

The installers are not signed by Apple or Microsoft, so your system asks once.

- **macOS:** choose **Open Anyway** in System Settings → Privacy & Security.
- **Windows:** choose **More info**, then **Run anyway**.

Updates after that are signed with Habi's own key.

</details>

## Supported

<details>
<summary><b>Agents</b> &nbsp;<sub>Claude Code, Cursor, Codex, Gemini CLI, GitHub Copilot, OpenCode, Junie</sub></summary>

| Agent | Skills | Instructions | MCP servers |
|---|---|---|---|
| **Claude Code** | `.claude/skills/` | `CLAUDE.md`, importing `AGENTS.md` | `.mcp.json` |
| **Cursor** | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `.cursor/mcp.json` |
| **Codex** | `.agents/skills/` | `AGENTS.md` | `.codex/config.toml` |
| **Gemini CLI** | `.agents/skills/` | `GEMINI.md`, importing `AGENTS.md` | `.gemini/settings.json` |
| **GitHub Copilot** | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `.mcp.json` |
| **OpenCode** | `.agents/skills/` or `.claude/skills/` | `AGENTS.md` | `opencode.json` |
| **Junie** | `.agents/skills/` | `AGENTS.md` | `.junie/mcp/mcp.json` |

</details>

<details>
<summary><b>Languages and frameworks</b> &nbsp;<sub>Java, Kotlin, TypeScript, JavaScript, Python, Go, Rust, PHP, C#, Scala, shell, HCL</sub></summary>

| Language | Frameworks | Build | Data access |
|---|---|---|---|
| **Java, Kotlin** | Spring Boot, Spring, Spring Security, Spring Batch, Spring Cloud, Quarkus, Micronaut, GraalVM | Maven, Gradle | JPA, jOOQ |
| **TypeScript, JavaScript** | React, Vue, Angular, Next.js, Svelte, Vite, Express, NestJS | npm, pnpm | |
| **Python** | Django, Flask, FastAPI | pip, Poetry, uv, Pipenv | SQLAlchemy |
| **Go** | Gin, Echo, Fiber, Wails | Go modules | GORM |
| **Rust** | Axum, Actix, Tauri, Tokio | Cargo | Diesel, SQLx |
| **PHP** | Laravel, Symfony | Composer | Doctrine |

</details>

<details>
<summary><b>Infrastructure</b> &nbsp;<sub>containers, cloud, CI, migrations, APIs</sub></summary>

| Area | Tools |
|---|---|
| **Containers** | Docker, Kubernetes, Helm, Kustomize |
| **Cloud** | Terraform, Terragrunt, Pulumi, Ansible |
| **CI** | GitHub Actions, GitLab CI |
| **Database migrations** | Liquibase, Flyway |
| **APIs** | OpenAPI, springdoc |

</details>

<details>
<summary><b>Data</b> &nbsp;<sub>pipelines, analysis</sub></summary>

| Area | Tools |
|---|---|
| **Pipelines** | dbt, Airflow, Dagster, Prefect, Spark, Beam, Kafka, Great Expectations |
| **Analysis** | pandas, Polars, DuckDB, Databricks, Delta Lake, MLflow, Jupyter |

</details>

<details>
<summary><b>Testing</b> &nbsp;<sub>unit, browser, API, acceptance, performance</sub></summary>

| Area | Tools |
|---|---|
| **Unit and integration** | JUnit, TestNG, Spock, Mockito, Testcontainers, Jest, Vitest, Mocha, Jasmine, Karma, pytest, PHPUnit, Bats |
| **Browser and mobile** | Playwright, Cypress, Selenium, WebdriverIO, Appium |
| **API** | REST Assured, Karate, Pact, WireMock, Postman |
| **Acceptance** | Cucumber, Gauge, Robot Framework |
| **Performance** | Gatling, JMeter, k6, Locust |

</details>

## A look inside

<table>
<tr>
<td width="50%" valign="top"><img src="docs/media/suggested.jpg" alt="Suggested skills for a project: each with the reason it fits and about how many tokens it costs, and a card to review and add them." width="100%"><br><b>Suggested, for every project</b></td>
<td width="50%" valign="top"><img src="docs/media/project.jpg" alt="A project in Habi: skills grouped by whether they are installed, required by the team or fit, with the files and lines that explain why one fits." width="100%"><br><b>Fits, and why</b></td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/media/explore.jpg" alt="Explore: fifteen public libraries from tool builders and the community, as cards, each saying which of your projects it suits." width="100%"><br><b>Libraries for your projects</b></td>
<td width="50%" valign="top"><img src="docs/media/install-review.jpg" alt="The install dialog: seven agent tools to choose from and the three files that will change." width="100%"><br><b>Seven agents, every file shown first</b></td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/media/skill-studio.jpg" alt="The Skill Studio: a skill written as a document you edit directly, with other skills woven into its sentences and a thread in the margin." width="100%"><br><b>Write a skill as one document</b></td>
<td width="50%" valign="top"><img src="docs/media/share-review.jpg" alt="Sharing a skill: the files that leave your machine, as a diff, and the checks that ran." width="100%"><br><b>Send it back as a pull request</b></td>
</tr>
</table>
