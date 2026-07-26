pub mod auth;
pub mod error;
pub mod models;
pub mod og;
pub mod og_image;
pub mod profile_id;
pub mod router;
pub mod store;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::LevelFilter;

/// Builds the `EnvFilter` shared by every binary, defaulting to INFO.
///
/// `EnvFilter::from_default_env()` defaults to ERROR-only when `RUST_LOG` is
/// unset, which silently drops every `metric = "..."` usage-counter line
/// (see `router.rs`, `store.rs`) before it ever reaches CloudWatch. Default
/// to INFO instead — `RUST_LOG` still overrides when set. Note this uses
/// `from_env_lossy()`, not `try_from_default_env().unwrap_or_else(...)`: the
/// latter's `Err` branch only fires on a malformed `RUST_LOG`, so an unset
/// one would parse as empty and yield a filter with nothing enabled at all.
fn env_filter() -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env_lossy()
}

/// Installs the JSON `tracing` subscriber shared by every binary.
pub fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(env_filter())
        .json()
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the same builder chain as `env_filter()`, but via
    /// `parse_lossy("")` instead of `from_env_lossy()` so the assertion
    /// doesn't depend on the test process's actual `RUST_LOG` — an empty
    /// directive string is exactly what an unset `RUST_LOG` parses as.
    #[test]
    fn default_directive_admits_info_when_rust_log_unset() {
        let filter = EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .parse_lossy("");
        let max_level = filter.max_level_hint();
        assert!(
            max_level.is_some_and(|level| level >= LevelFilter::INFO),
            "expected INFO to be enabled by default, got {max_level:?}"
        );
    }
}
