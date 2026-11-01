//! Product naming in one place, so a later rename touches one file (plus the
//! desktop configuration and documentation).

/// Display name.
pub const APP_NAME: &str = "Habi";
/// Overrides the data directory (useful for tests and portable setups).
pub const HOME_ENV: &str = "HABI_HOME";
/// Lock file recording what Habi installed in a project.
pub const LOCK_FILE: &str = ".habi/lock.json";
/// Git ref namespace used inside Habi-managed caches.
pub const REF_NAMESPACE: &str = "refs/habi";
/// Prefix for contribution branches.
pub const CONTRIBUTION_BRANCH_PREFIX: &str = "habi/contrib";
/// Qualifier/organization/application for platform data directories.
/// Matches the desktop bundle identifier `com.acltabontabon.habi`; changing it
/// moves users' local data (projects and installed files are unaffected).
pub const DIRS: (&str, &str, &str) = ("com", "acltabontabon", "Habi");
