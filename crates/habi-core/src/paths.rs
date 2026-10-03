//! Safe handling of relative paths.
//!
//! Library content, lock files and IPC requests all name files with relative
//! paths that Habi does not control. `RelPath` is the only way those strings
//! become file-system locations: it rejects absolute paths, `..`, empty
//! segments, backslashes, drive prefixes and names that Windows would alias
//! (trailing dots or spaces, device names, `<>:"|?*`), and `resolve_for_write` refuses to
//! cross symbolic links so a hostile tree cannot redirect a write outside the
//! project.

use crate::error::{HabiError, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

/// Maximum length of a relative path Habi will handle. Long enough for deep
/// monorepos, short enough to avoid pathological input.
pub const MAX_REL_PATH_LEN: usize = 1024;

/// Characters Windows does not allow in file names.
const WINDOWS_FORBIDDEN: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Why a path component would name a different file (or a device) on
/// Windows, if it would. Checked on every platform: a project written on macOS
/// or Linux is often checked out on Windows, where `a.` is the same file as
/// `a`, `nul.txt` is the null device and `a:b` is an alternate data stream.
pub(crate) fn windows_alias(part: &str) -> Option<&'static str> {
    if part.chars().any(|c| WINDOWS_FORBIDDEN.contains(&c)) {
        return Some(
            r#"contains a character Windows does not allow in file names (< > : " | ? *)"#,
        );
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return Some("a name ends with a dot or space, which Windows drops");
    }
    // Device names are reserved with any extension (`con.txt`), in any case,
    // and with trailing spaces before the extension (`nul .md`).
    let stem = part.split('.').next().unwrap_or(part).trim_end_matches(' ');
    let lower = stem.to_ascii_lowercase();
    let reserved = matches!(
        lower.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || ["com", "lpt"].iter().any(|prefix| {
        lower.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    reserved.then_some("uses a name Windows reserves for a device (such as CON, NUL, COM1 or LPT1)")
}

/// A validated, normalized, forward-slash relative path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelPath(String);

impl RelPath {
    pub fn new(raw: &str) -> Result<Self> {
        let invalid =
            |why: &str| HabiError::invalid(format!("invalid relative path `{raw}`: {why}"));
        if raw.is_empty() {
            return Err(invalid("empty"));
        }
        if raw.len() > MAX_REL_PATH_LEN {
            return Err(invalid("too long"));
        }
        if raw.contains('\0') || raw.contains('\\') {
            return Err(invalid("contains a NUL or backslash"));
        }
        if raw.starts_with('/') {
            return Err(invalid("absolute"));
        }
        let mut parts = Vec::new();
        for part in raw.split('/') {
            match part {
                "" | "." => continue,
                ".." => return Err(invalid("contains `..`")),
                // A `.git` component could plant a nested repository (and its
                // hooks or config) inside a project.
                p if p.eq_ignore_ascii_case(".git") => return Err(invalid("contains `.git`")),
                p if p.chars().any(|c| c.is_control()) => {
                    return Err(invalid("contains control characters"));
                }
                p => {
                    if let Some(why) = windows_alias(p) {
                        return Err(invalid(why));
                    }
                    parts.push(p)
                }
            }
        }
        if parts.is_empty() {
            return Err(invalid("names no file"));
        }
        Ok(RelPath(parts.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn join(&self, child: &str) -> Result<RelPath> {
        RelPath::new(&format!("{}/{}", self.0, child))
    }

    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    pub fn parent(&self) -> Option<RelPath> {
        self.0.rsplit_once('/').map(|(p, _)| RelPath(p.to_string()))
    }

    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// True if `self` equals `prefix` or lies underneath it.
    pub fn starts_with(&self, prefix: &RelPath) -> bool {
        self.0 == prefix.0 || self.0.starts_with(&format!("{}/", prefix.0))
    }

    /// Relative path after `prefix`, if `self` is inside it.
    pub fn strip_prefix(&self, prefix: &RelPath) -> Option<RelPath> {
        self.0
            .strip_prefix(&format!("{}/", prefix.0))
            .map(|rest| RelPath(rest.to_string()))
    }

    /// Joins onto `root` without any file-system checks. Use only for reads
    /// where the caller separately refuses symbolic links, or for display.
    pub fn to_path(&self, root: &Path) -> PathBuf {
        let mut p = root.to_path_buf();
        for part in self.components() {
            p.push(part);
        }
        p
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for RelPath {
    type Error = HabiError;
    fn try_from(value: String) -> Result<Self> {
        RelPath::new(&value)
    }
}

impl From<RelPath> for String {
    fn from(value: RelPath) -> Self {
        value.0
    }
}

impl ts_rs::TS for RelPath {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;
    fn name(_: &ts_rs::Config) -> String {
        "string".into()
    }
    fn inline(_: &ts_rs::Config) -> String {
        "string".into()
    }
    fn decl(_: &ts_rs::Config) -> String {
        "type RelPath = string;".into()
    }
    fn decl_concrete(_: &ts_rs::Config) -> String {
        "type RelPath = string;".into()
    }
}

/// Resolves `rel` under `root` for writing. Every existing component between
/// `root` and the target must be a real directory (not a symbolic link), and
/// the target itself, if it exists, must not be a symbolic link. Components
/// that do not exist yet are fine: they will be created as directories.
pub fn resolve_for_write(root: &Path, rel: &RelPath) -> Result<PathBuf> {
    let mut current = root.to_path_buf();
    let parts: Vec<&str> = rel.components().collect();
    for (i, part) in parts.iter().enumerate() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(HabiError::PathEscape(rel.to_string()));
                }
                let is_last = i == parts.len() - 1;
                if !is_last && !meta.is_dir() {
                    return Err(HabiError::Conflict(format!(
                        "`{}` is a file, but Habi needs a directory there",
                        parts.get(..=i).unwrap_or_default().join("/")
                    )));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Nothing below a missing component can be a link.
                for rest in parts.get(i + 1..).unwrap_or_default() {
                    current.push(rest);
                }
                return Ok(current);
            }
            Err(e) => return Err(HabiError::io(format!("checking {}", rel), e)),
        }
    }
    Ok(current)
}

/// Like `resolve_for_write`, but for reads: refuses symbolic links anywhere
/// along the path and returns `None` if the file does not exist.
pub fn resolve_for_read(root: &Path, rel: &RelPath) -> Result<Option<PathBuf>> {
    let path = resolve_for_write(root, rel)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => Ok(Some(path)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(HabiError::io(format!("reading {}", rel), e)),
    }
}

/// Where `rel` really is, if reaching it crosses symbolic links that stay
/// inside `root` (such as `CLAUDE.md -> AGENTS.md` or
/// `.claude/skills -> ../.agents/skills`). Returns `None` if no component of
/// `rel` is a link. A link that leaves `root`, dangles, or leads into a `.git`
/// folder is refused (`PathEscape`). Habi never writes through links; callers
/// use this to recognize a layout and say what to do about it.
pub fn resolve_links(root: &Path, rel: &RelPath) -> Result<Option<RelPath>> {
    let canonical_root =
        canonical(root).map_err(|e| HabiError::io(format!("opening {}", root.display()), e))?;
    let mut current = rel.clone();
    let mut crossed = false;
    // Bounded, like the operating system's own limit on link chains.
    for _ in 0..16 {
        let parts: Vec<&str> = current.components().collect();
        let mut path = root.to_path_buf();
        let mut link_at = None;
        for (i, part) in parts.iter().enumerate() {
            path.push(part);
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    link_at = Some(i);
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let Some(i) = link_at else {
            return Ok(crossed.then_some(current));
        };
        crossed = true;
        let escape = || HabiError::PathEscape(rel.to_string());
        let target = canonical(&path).map_err(|_| escape())?;
        let inside = target.strip_prefix(&canonical_root).map_err(|_| escape())?;
        let mut resolved: Vec<String> = inside
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        resolved.extend(
            parts
                .get(i + 1..)
                .unwrap_or_default()
                .iter()
                .map(|s| s.to_string()),
        );
        if resolved.is_empty() {
            return Err(escape());
        }
        current = RelPath::new(&resolved.join("/")).map_err(|_| escape())?;
    }
    Err(HabiError::PathEscape(rel.to_string()))
}

/// Canonical absolute path of a directory the user selected (project root,
/// local source). Fails if it is not a directory.
pub fn canonical_dir(path: &Path) -> Result<PathBuf> {
    let canonical =
        canonical(path).map_err(|e| HabiError::io(format!("opening {}", path.display()), e))?;
    if !canonical.is_dir() {
        return Err(HabiError::invalid(format!(
            "{} is not a directory",
            path.display()
        )));
    }
    Ok(canonical)
}

/// Whether `path` (as text) names a place on another machine, or could: a UNC
/// path (`\\host\share`, `//host/share`, with either slash), or a device or
/// verbatim one that reaches one (`\\?\UNC\host\share`). Windows opens those
/// over SMB and offers the host the person's sign-in (an NTLM hash), so a path
/// read from a file Habi does not control must never lead there. Checked on
/// every platform; elsewhere it only refuses an unusual way to write `/`.
pub fn is_network_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('/' | '\\'), Some('/' | '\\'))
    )
}

/// Replaces the user's home directory with `~` for display and logs.
pub fn display_path(path: &Path) -> String {
    if let Some(home) = directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
        && let Ok(rest) = path.strip_prefix(&home)
    {
        return if rest.as_os_str().is_empty() {
            "~".into()
        } else {
            format!("~/{}", rest.to_string_lossy().replace('\\', "/"))
        };
    }
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../b",
            "a\\b",
            "C:/x",
            "a/\0b",
            ".",
            "./",
            ".git/config",
            "skills/x/.GIT/hooks/pre-commit",
        ] {
            assert!(RelPath::new(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn rejects_names_windows_would_alias() {
        for bad in [
            "skills/a./SKILL.md",
            "skills/a /SKILL.md",
            "skills/x/notes.md.",
            "skills/x/...",
            "con",
            "skills/x/CON",
            "skills/x/nul.txt",
            "skills/x/Aux.tar.gz",
            "skills/x/prn",
            "skills/x/com1.md",
            "skills/x/LPT9",
            "skills/x/com\u{b9}.md",
            "skills/x/nul .md",
            "skills/x/a<b",
            "skills/x/a>b",
            "skills/x/a:b",
            "skills/x/a\"b",
            "skills/x/a|b",
            "skills/x/a?b",
            "skills/x/a*b",
            "skills/x/a\u{7}b",
            "skills/x/a\nb",
        ] {
            assert!(RelPath::new(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in [
            ".agents/skills/console/SKILL.md",
            "skills/x/com10.md",
            "skills/x/lpt0",
            "skills/x/nulls.md",
            "skills/x/con-artist/a.md",
            "skills/x/.hidden",
            "skills/x/a b.md",
        ] {
            assert!(RelPath::new(good).is_ok(), "{good:?} should be accepted");
        }
    }

    #[test]
    fn tells_paths_on_other_machines_apart() {
        for remote in [
            r"\\host\share\repo",
            "//host/share/repo",
            r"\/host/share",
            r"/\host\share",
            r"\\?\UNC\host\share\repo",
            "//?/UNC/host/share",
            r"\\.\UNC\host\share",
            r"\\host@SSL\DavWWWRoot\repo",
        ] {
            assert!(is_network_path(remote), "{remote}");
        }
        for local in [
            "C:/Users/ana/repo/.git/worktrees/wt",
            r"C:\Users\ana\repo\.git",
            "/home/ana/repo/.git",
            r"\repo\.git",
            "../..",
            ".git/worktrees/wt",
            "",
        ] {
            assert!(!is_network_path(local), "{local}");
        }
    }

    #[test]
    fn normalizes_redundant_segments() {
        assert_eq!(RelPath::new("./a//b/./c/").unwrap().as_str(), "a/b/c");
    }

    #[test]
    fn prefix_handling_respects_segment_boundaries() {
        let a = RelPath::new("skills/a").unwrap();
        let ab = RelPath::new("skills/ab").unwrap();
        let inner = RelPath::new("skills/a/SKILL.md").unwrap();
        assert!(!ab.starts_with(&a));
        assert!(inner.starts_with(&a));
        assert_eq!(inner.strip_prefix(&a).unwrap().as_str(), "SKILL.md");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_writes_through_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        let rel = RelPath::new("link/file.txt").unwrap();
        assert!(matches!(
            resolve_for_write(root.path(), &rel),
            Err(HabiError::PathEscape(_))
        ));
        let ok = RelPath::new("real/dir/file.txt").unwrap();
        assert!(resolve_for_write(root.path(), &ok).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_links_that_stay_in_the_project() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let r = root.path();
        std::fs::write(r.join("AGENTS.md"), "x").unwrap();
        symlink("AGENTS.md", r.join("CLAUDE.md")).unwrap();
        std::fs::create_dir_all(r.join(".agents/skills")).unwrap();
        std::fs::create_dir_all(r.join(".claude")).unwrap();
        symlink("../.agents/skills", r.join(".claude/skills")).unwrap();
        symlink(outside.path(), r.join("out")).unwrap();
        symlink("missing", r.join("dangling")).unwrap();
        std::fs::create_dir_all(r.join(".git")).unwrap();
        symlink(".git", r.join("sneaky")).unwrap();

        let resolve = |p: &str| resolve_links(r, &RelPath::new(p).unwrap());
        assert_eq!(resolve("CLAUDE.md").unwrap().unwrap().as_str(), "AGENTS.md");
        assert_eq!(
            resolve(".claude/skills/x/SKILL.md")
                .unwrap()
                .unwrap()
                .as_str(),
            ".agents/skills/x/SKILL.md"
        );
        assert!(resolve("AGENTS.md").unwrap().is_none());
        assert!(resolve("not/there").unwrap().is_none());
        for bad in ["out/file", "dangling", "sneaky/config"] {
            assert!(
                matches!(resolve(bad), Err(HabiError::PathEscape(_))),
                "{bad}"
            );
        }
    }
}

/// `std::fs::canonicalize`, without Windows' `\\?\` verbatim prefix where an
/// ordinary path names the same file. Git and most tools misread verbatim
/// paths (`\\?\C:\repo` looks like a network host), and people should never
/// see them. Use this instead of `std::fs::canonicalize` everywhere.
pub fn canonical(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

#[cfg(test)]
mod canonical_tests {
    use super::canonical;

    #[test]
    fn canonical_paths_are_absolute_and_ordinary() {
        let dir = tempfile::tempdir().unwrap();
        let path = canonical(dir.path()).unwrap();
        assert!(path.is_absolute());
        // Git misreads Windows verbatim paths (`\\?\C:\...`) as network hosts.
        assert!(
            !path.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            path.display()
        );
    }
}
