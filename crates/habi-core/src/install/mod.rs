//! Safe installation, update, removal and restore of library content.
//!
//! `plan` computes previewable changes without touching the project;
//! `apply` executes a plan with locking, precondition checks, journaling and
//! crash recovery; `status` compares installed content with the project and
//! the team library.

pub mod apply;
pub mod diff;
pub mod lock;
pub mod plan;
pub mod status;
