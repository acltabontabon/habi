//! The explicitly labeled sample workspace.
//!
//! Copies the bundled example library and repositories into
//! `<data>/sample`, makes the library a local Git repository, registers it
//! as a source named "Sample team library" and opens the sample projects.
//! Nothing here is presented as the user's data: projects are marked
//! `sample` and live only under Habi's data directory.

use crate::cancel::CancelToken;
use crate::error::{HabiError, Result};
use crate::process::{self, Spec};
use crate::service::{Habi, ProjectRecord};
use crate::source::{NewSource, Source, TrackedRef};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use ts_rs::TS;

pub const SAMPLE_SOURCE_NAME: &str = "Sample team library";
pub const SAMPLE_SECURITY_SOURCE_NAME: &str = "Sample security library";
const SAMPLE_REPOS: &[&str] = &[
    "billing-service",
    "storefront-web",
    "platform-monorepo",
    "orders-api",
    "inventory-gradle-multi",
    "agent-ready-service",
    "legacy-scripts",
];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SampleWorkspace {
    pub sources: Vec<Source>,
    pub projects: Vec<ProjectRecord>,
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|e| HabiError::io("creating the sample workspace", e))?;
    for entry in std::fs::read_dir(from).map_err(|e| HabiError::io("reading bundled samples", e))? {
        let entry = entry.map_err(|e| HabiError::io("reading bundled samples", e))?;
        let meta = std::fs::symlink_metadata(entry.path())
            .map_err(|e| HabiError::io("reading bundled samples", e))?;
        let target = to.join(entry.file_name());
        if meta.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if meta.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| HabiError::io("copying bundled samples", e))?;
        }
    }
    Ok(())
}

fn git(dir: &Path, args: &[&str]) -> Result<()> {
    let program = which::which("git").map_err(|_| HabiError::NotFound("git".into()))?;
    let mut all: Vec<String> = [
        "-c",
        "user.name=Habi sample",
        "-c",
        "user.email=sample@habi.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "core.hooksPath=",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    all.extend(args.iter().map(|s| s.to_string()));
    let mut spec = Spec::new(program, all);
    spec.cwd = Some(dir.to_path_buf());
    spec.timeout = Duration::from_secs(30);
    let out = process::run(spec, &CancelToken::new())?;
    if !out.success() {
        return Err(HabiError::Internal(format!(
            "git {} failed: {}",
            args.join(" "),
            out.stderr_text()
        )));
    }
    Ok(())
}

fn sample_library(habi: &Habi, from: &Path, to: &Path, name: &str) -> Result<Source> {
    copy_tree(from, to)?;
    let git_available = which::which("git").is_ok();
    if git_available {
        git(to, &["init", "-q"])?;
        git(to, &["add", "-A"])?;
        git(to, &["commit", "-q", "-m", "Sample library"])?;
    }
    let source = habi.sources().add(&NewSource {
        name: name.into(),
        location: to.to_string_lossy().into_owned(),
        subdir: None,
        tracked: if git_available {
            TrackedRef::Branch {
                name: "main".into(),
            }
        } else {
            TrackedRef::Default
        },
    })?;
    habi.sources().refresh(&source.id, &CancelToken::new())?;
    habi.sources().get(&source.id)
}

/// Creates (or recreates) the sample workspace from `bundled` (a directory
/// containing `libraries/*` and `repos/*`).
pub fn create(habi: &Habi, bundled: &Path) -> Result<SampleWorkspace> {
    let root = habi.paths.root.join("sample");
    for existing in habi.sources().list()? {
        if existing.name == SAMPLE_SOURCE_NAME || existing.name == SAMPLE_SECURITY_SOURCE_NAME {
            habi.sources().remove(&existing.id)?;
        }
    }
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|e| HabiError::io("resetting the sample workspace", e))?;
    }
    let source = sample_library(
        habi,
        &bundled.join("libraries/example-team-library"),
        &root.join("team-library"),
        SAMPLE_SOURCE_NAME,
    )?;
    let security = sample_library(
        habi,
        &bundled.join("libraries/security-guild-library"),
        &root.join("security-library"),
        SAMPLE_SECURITY_SOURCE_NAME,
    )?;
    let mut projects = Vec::new();
    for name in SAMPLE_REPOS {
        let dir = root.join("projects").join(name);
        copy_tree(&bundled.join("repos").join(name), &dir)?;
        projects.push(habi.open_project(&dir)?);
    }
    Ok(SampleWorkspace {
        sources: vec![source, security],
        projects,
    })
}
