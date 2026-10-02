//! Habi core: everything the desktop app and CLI share.
//!
//! The crate is independent of any UI:
//! - `inspect`: read-only repository inspection producing facts with provenance.
//! - `catalog`: the public skill libraries Habi suggests, previewed before connecting.
//! - `library`: reading team libraries (Agent Skills plus optional Habi metadata).
//! - `matching`: deterministic, three-valued applicability evaluation.
//! - `source`: team library sources (Git or folders), snapshots, offline cache.
//! - `install`: plan/apply/restore with journaling; installation status.
//! - `recommend`: applicability, readiness, installation and evidence per item.
//! - `contribute`: isolated contribution drafts, commits, patches, publishing.
//! - `checks`: explicit, previewed verification commands.
//! - `skills`: local skills (drafts, imported copies), discovery and import.
//! - `maintenance`: pruning old operation records, snapshots and stored content.
//! - `service`: the facade both front ends call.
//! - `paths`, `fsutil`, `process`, `redact`: safety primitives.

// Slicing and indexing panic on a bad boundary or index; production code
// uses checked access (`get`), or explains why the bound holds.
#![cfg_attr(not(test), warn(clippy::string_slice, clippy::indexing_slicing))]

pub mod brand;
pub mod cancel;
pub mod catalog;
pub mod checks;
pub mod clients;
pub mod contribute;
pub mod diagnostics;
pub mod error;
pub mod fsutil;
pub mod inspect;
pub mod install;
pub mod library;
pub mod maintenance;
pub mod matching;
pub mod paths;
pub mod process;
pub mod recommend;
pub mod redact;
pub mod review;
pub mod sample;
pub mod service;
pub mod skills;
pub mod source;
pub mod store;
pub mod time;
