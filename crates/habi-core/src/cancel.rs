//! Cooperative cancellation for long-running work (scans, Git, checks).

use crate::error::{HabiError, Result};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Returns `Err(Cancelled)` once cancellation was requested. Call this at
    /// loop boundaries in long-running work.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(HabiError::Cancelled)
        } else {
            Ok(())
        }
    }
}
