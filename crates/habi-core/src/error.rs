//! Error types shared by every Habi service.
//!
//! `HabiError` is what core functions return. `ErrorInfo` is the serializable
//! shape the CLI and desktop show to people: a stable `code` the UI can branch
//! on and a message written for humans.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Why a Git operation failed, classified from Git's own output so the UI can
/// say something more useful than "exit status 128".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GitFailure {
    /// Host unreachable, DNS failure, timeout.
    Network,
    /// Credentials rejected or missing.
    Authentication,
    /// Repository or ref does not exist (or is not visible to these credentials).
    NotFound,
    /// Git itself is not installed or could not be started.
    GitMissing,
    /// The remote rejected a push (permissions, protected branch, ...).
    Rejected,
    Other,
}

#[derive(Debug, thiserror::Error)]
pub enum HabiError {
    #[error("{0}")]
    InvalidInput(String),

    #[error("{0} was not found")]
    NotFound(String),

    #[error("refusing to use path `{0}`: it leaves its permitted root or crosses a symbolic link")]
    PathEscape(String),

    #[error("the preview is out of date: {0}")]
    StalePlan(String),

    #[error("{0}")]
    Conflict(String),

    #[error("another Habi operation is using {0}; try again when it finishes")]
    Busy(String),

    #[error("the operation was cancelled")]
    Cancelled,

    #[error("{message}")]
    Git {
        failure: GitFailure,
        message: String,
    },

    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },

    #[error("local database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("{0}")]
    Unsupported(String),

    #[error("{0}")]
    Internal(String),
}

pub type Result<T, E = HabiError> = std::result::Result<T, E>;

impl HabiError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        HabiError::Io {
            context: context.into(),
            source,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        HabiError::InvalidInput(message.into())
    }

    /// Stable identifier for the error category, used by UIs and scripts.
    pub fn code(&self) -> &'static str {
        match self {
            HabiError::InvalidInput(_) => "invalidInput",
            HabiError::NotFound(_) => "notFound",
            HabiError::PathEscape(_) => "pathEscape",
            HabiError::StalePlan(_) => "stalePlan",
            HabiError::Conflict(_) => "conflict",
            HabiError::Busy(_) => "busy",
            HabiError::Cancelled => "cancelled",
            HabiError::Git { failure, .. } => match failure {
                GitFailure::Network => "gitNetwork",
                GitFailure::Authentication => "gitAuthentication",
                GitFailure::NotFound => "gitNotFound",
                GitFailure::GitMissing => "gitMissing",
                GitFailure::Rejected => "gitRejected",
                GitFailure::Other => "git",
            },
            HabiError::Io { source, .. } => match source.kind() {
                std::io::ErrorKind::PermissionDenied => "permissionDenied",
                std::io::ErrorKind::NotFound => "notFound",
                std::io::ErrorKind::StorageFull => "diskFull",
                _ => "io",
            },
            HabiError::Db(_) => "database",
            HabiError::Unsupported(_) => "unsupported",
            HabiError::Internal(_) => "internal",
        }
    }

    pub fn to_info(&self) -> ErrorInfo {
        ErrorInfo {
            code: self.code().to_string(),
            message: crate::redact::redact(&self.to_string()),
        }
    }
}

impl From<std::io::Error> for HabiError {
    fn from(source: std::io::Error) -> Self {
        HabiError::Io {
            context: "file system".into(),
            source,
        }
    }
}

/// Serializable error returned over IPC and printed by the CLI in JSON mode.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
}

impl From<HabiError> for ErrorInfo {
    fn from(e: HabiError) -> Self {
        e.to_info()
    }
}
