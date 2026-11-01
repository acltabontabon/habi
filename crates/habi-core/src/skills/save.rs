//! A recoverable two-file save. Journal paths are package-relative basenames.
use super::*;

#[derive(Serialize, Deserialize)]
struct Staged {
    target: String,
    temp: String,
    digest: String,
    remove: bool,
    previous: Option<Vec<u8>>,
}

fn io(e: std::io::Error) -> HabiError {
    HabiError::io("saving skill files", e)
}
fn journal(dir: &Path) -> Result<PathBuf> {
    Ok(dir
        .parent()
        .ok_or_else(|| HabiError::invalid("The skill folder is missing."))?
        .join("save-journal.json"))
}
#[cfg(test)]
thread_local! { static FAILURE: std::cell::Cell<Option<SaveStep>> = const { std::cell::Cell::new(None) }; }
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveStep {
    Staged,
    Journaled,
    FirstRename,
}
#[cfg(test)]
pub(crate) fn fail_after(step: SaveStep) {
    FAILURE.with(|f| f.set(Some(step)));
}
fn checkpoint(step: SaveStep) -> Result<()> {
    #[cfg(test)]
    if FAILURE.with(|f| f.get() == Some(step)) {
        FAILURE.with(|f| f.set(None));
        return Err(HabiError::invalid("The test interrupted this save."));
    }
    let _ = step;
    Ok(())
}

fn safe(dir: &Path, entry: &Staged) -> bool {
    matches!(entry.target.as_str(), "SKILL.md" | "habi.yaml" | "habi.yml")
        && entry.temp.starts_with(".habi-save-")
        && Path::new(&entry.temp).components().count() == 1
        && entry
            .temp
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        && [dir.join(&entry.target), dir.join(&entry.temp)]
            .iter()
            .all(|p| {
                std::fs::symlink_metadata(p)
                    .map_or(true, |m| m.is_file() && !m.file_type().is_symlink())
            })
}
fn matches(path: &Path, digest: &str) -> bool {
    matches!(read_bounded(path, MAX_FILE_BYTES), Ok(Bounded::Content(bytes)) if sha256(&bytes) == digest)
}
fn sync(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(io)?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn clean_temps(dir: &Path) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut changed = false;
    for entry in std::fs::read_dir(dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".habi-save-")
            && !entry.file_type().map_err(io)?.is_dir()
        {
            std::fs::remove_file(entry.path()).map_err(io)?;
            changed = true;
        }
    }
    if changed {
        sync(dir)?;
    }
    Ok(())
}

pub(super) fn recover(dir: &Path) -> Result<bool> {
    for folder in [dir, dir.parent().unwrap_or(dir)] {
        if std::fs::symlink_metadata(folder).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(HabiError::PathEscape("the skill folder".into()));
        }
    }
    let path = journal(dir)?;
    if !path.exists() {
        clean_temps(dir)?;
        return Ok(false);
    }
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        std::fs::remove_file(&path).map_err(io)?;
        clean_temps(dir)?;
        return Ok(true);
    }
    let entries: Vec<Staged> = match read_bounded(&path, 20 * 1024 * 1024).and_then(|read| {
        let Bounded::Content(b) = read else {
            return Err(HabiError::invalid("The interrupted save is too large."));
        };
        serde_json::from_slice::<Vec<Staged>>(&b)
            .map_err(|_| HabiError::invalid("The interrupted save could not be read."))
    }) {
        Ok(entries)
            if !entries.is_empty()
                && entries.len() <= 2
                && entries.iter().all(|e| {
                    safe(dir, e)
                        && e.previous
                            .as_ref()
                            .is_none_or(|bytes| bytes.len() as u64 <= MAX_FILE_BYTES)
                })
                && entries
                    .iter()
                    .map(|e| &e.temp)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == entries.len()
                && entries
                    .iter()
                    .map(|e| &e.target)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == entries.len() =>
        {
            entries
        }
        _ => {
            std::fs::remove_file(path).map_err(io)?;
            clean_temps(dir)?;
            return Ok(true);
        }
    };
    let ready = entries.iter().all(|e| {
        matches(&dir.join(&e.temp), &e.digest)
            || (!e.remove && matches(&dir.join(&e.target), &e.digest))
            || (e.remove && !dir.join(&e.target).exists())
    });
    for e in &entries {
        let target = dir.join(&e.target);
        let temp = dir.join(&e.temp);
        if ready {
            if e.remove {
                if target.exists() {
                    std::fs::remove_file(&target).map_err(io)?;
                }
            } else if matches(&temp, &e.digest) {
                std::fs::rename(&temp, &target).map_err(io)?;
            }
        } else {
            match &e.previous {
                Some(bytes) => atomic_write_mode(&target, bytes, None)?,
                None if target.exists() => std::fs::remove_file(&target).map_err(io)?,
                None => {}
            }
        }
        if temp.exists() {
            std::fs::remove_file(temp).map_err(io)?;
        }
    }
    sync(dir)?;
    std::fs::remove_file(path).map_err(io)?;
    sync(dir.parent().unwrap_or(dir))?;
    Ok(!ready)
}

pub(super) fn coordinated(dir: &Path, files: &[(&Path, Option<&[u8]>)]) -> Result<()> {
    use std::io::Write;
    let mut entries = Vec::new();
    for (target, content) in files {
        let mut temp = tempfile::Builder::new()
            .prefix(".habi-save-")
            .tempfile_in(dir)
            .map_err(io)?;
        temp.write_all(content.unwrap_or_default()).map_err(io)?;
        if let Ok(meta) = std::fs::metadata(target) {
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(io)?;
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temp.as_file()
                    .set_permissions(std::fs::Permissions::from_mode(0o644))
                    .map_err(io)?;
            }
        }
        temp.as_file().sync_all().map_err(io)?;
        let (_, temp) = temp.keep().map_err(|e| io(e.error))?;
        entries.push(Staged {
            target: target
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            temp: temp
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            digest: sha256(content.unwrap_or_default()),
            remove: content.is_none(),
            previous: std::fs::read(target).ok(),
        });
    }
    if let Err(error) = checkpoint(SaveStep::Staged) {
        for entry in &entries {
            let _ = std::fs::remove_file(dir.join(&entry.temp));
        }
        return Err(error);
    }
    sync(dir)?;
    crate::fsutil::atomic_write(
        &journal(dir)?,
        &serde_json::to_vec(&entries).map_err(|e| HabiError::Internal(e.to_string()))?,
    )?;
    checkpoint(SaveStep::Journaled)?;
    if let Some(first) = entries.first() {
        if first.remove {
            if dir.join(&first.target).exists() {
                std::fs::remove_file(dir.join(&first.target)).map_err(io)?;
            }
        } else {
            std::fs::rename(dir.join(&first.temp), dir.join(&first.target)).map_err(io)?;
        }
        sync(dir)?;
        checkpoint(SaveStep::FirstRename)?;
    }
    // Recovery finishing the save is success. Recovery undoing it isn't, and must not read as saved.
    if recover(dir)? {
        return Err(HabiError::invalid(
            "Habi couldn't finish writing this skill, so it kept the previous version. Your edits are still on screen; try saving again.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("package");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), b"old body").unwrap();
        std::fs::write(dir.join("habi.yaml"), b"old metadata").unwrap();
        (temp, dir)
    }
    fn interrupted(dir: &Path, step: SaveStep) {
        fail_after(step);
        assert!(
            coordinated(
                dir,
                &[
                    (&dir.join("SKILL.md"), Some(b"new body")),
                    (&dir.join("habi.yaml"), Some(b"new metadata"))
                ]
            )
            .is_err()
        );
    }
    #[test]
    fn opening_and_editing_recover_before_reading_or_checking_a_base() {
        let temp = tempfile::tempdir().unwrap();
        let habi = crate::service::Habi::open(AppPaths::at(temp.path().into())).unwrap();
        let skill = habi
            .create_skill(
                &NewSkill {
                    title: "Birch plan".into(),
                    description: "Plan fictional changes.".into(),
                    template: SkillTemplate::Blank,
                },
                None,
            )
            .unwrap();
        let mut document = skill.document.clone();
        document.body = "Use `cedar` skill.\n".into();
        let entries = vec![ComposeEntry {
            skill: "cedar".into(),
            roles: vec!["after".into()],
            from: None,
        }];
        fail_after(SaveStep::FirstRename);
        assert!(
            habi.skills()
                .save_document(
                    &skill.summary.id,
                    "Birch plan",
                    &document,
                    skill.document_digest.as_deref(),
                    Some(entries.clone()),
                    None
                )
                .is_err()
        );
        let recovered = habi.skills().get(&skill.summary.id).unwrap();
        assert_eq!(recovered.document.body, document.body);
        assert_eq!(recovered.composes, entries);
        document.body.push_str("Review the result.\n");
        fail_after(SaveStep::Journaled);
        assert!(
            habi.skills()
                .save_document(
                    &skill.summary.id,
                    "Birch plan",
                    &document,
                    recovered.document_digest.as_deref(),
                    Some(vec![]),
                    recovered.metadata_digest.as_deref()
                )
                .is_err()
        );
        let conflict = habi
            .skills()
            .save_document(
                &skill.summary.id,
                "Birch plan",
                &recovered.document,
                recovered.document_digest.as_deref(),
                None,
                None,
            )
            .unwrap_err();
        assert!(matches!(conflict, HabiError::Conflict(_)));
        assert_eq!(
            habi.skills().get(&skill.summary.id).unwrap().document.body,
            document.body
        );
    }

    #[test]
    fn staged_failure_changes_neither_file() {
        let (_temp, dir) = setup();
        interrupted(&dir, SaveStep::Staged);
        assert!(!journal(&dir).unwrap().exists());
        assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), b"old body");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    }
    #[test]
    fn interrupted_saves_roll_forward_and_recovery_is_idempotent() {
        for step in [SaveStep::Journaled, SaveStep::FirstRename] {
            let (_temp, dir) = setup();
            interrupted(&dir, step);
            assert!(!recover(&dir).unwrap());
            assert!(!recover(&dir).unwrap());
            assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), b"new body");
            assert_eq!(
                std::fs::read(dir.join("habi.yaml")).unwrap(),
                b"new metadata"
            );
        }
    }
    #[test]
    fn corrupt_temp_restores_previous_files_even_after_one_rename() {
        let (_temp, dir) = setup();
        interrupted(&dir, SaveStep::FirstRename);
        let entries: Vec<Staged> =
            serde_json::from_slice(&std::fs::read(journal(&dir).unwrap()).unwrap()).unwrap();
        std::fs::write(dir.join(&entries[1].temp), b"corrupt").unwrap();
        assert!(recover(&dir).unwrap());
        assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), b"old body");
        assert_eq!(
            std::fs::read(dir.join("habi.yaml")).unwrap(),
            b"old metadata"
        );
        assert!(!recover(&dir).unwrap());
    }
    #[test]
    fn a_verified_target_is_not_replaced_by_a_corrupt_leftover_temp() {
        let (_temp, dir) = setup();
        interrupted(&dir, SaveStep::FirstRename);
        let entries: Vec<Staged> =
            serde_json::from_slice(&std::fs::read(journal(&dir).unwrap()).unwrap()).unwrap();
        std::fs::write(dir.join(&entries[0].temp), b"corrupt leftover").unwrap();
        assert!(!recover(&dir).unwrap());
        assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), b"new body");
        assert_eq!(
            std::fs::read(dir.join("habi.yaml")).unwrap(),
            b"new metadata"
        );
    }

    #[test]
    fn outside_paths_are_refused_without_touching_them() {
        let (temp, dir) = setup();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"keep").unwrap();
        let entries = vec![Staged {
            target: "../outside".into(),
            temp: "../outside".into(),
            digest: sha256(b"keep"),
            remove: false,
            previous: None,
        }];
        std::fs::write(
            journal(&dir).unwrap(),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        assert!(recover(&dir).unwrap());
        assert_eq!(std::fs::read(outside).unwrap(), b"keep");
        assert!(!journal(&dir).unwrap().exists());
    }
}
