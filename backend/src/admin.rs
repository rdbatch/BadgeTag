//! Admin allowlist: which authenticated users may reach the admin-only
//! endpoints (currently the read-only "list all profiles" view).
//!
//! The allowlist is supplied at deploy time via the `ADMIN_EMAILS`
//! environment variable (comma-separated), parsed once at startup into an
//! `AdminAllowlist`. Keeping it server-side (rather than hardcoding admin
//! emails in the frontend) means the only trustworthy admin decision — the
//! one that gates the data — is made against the verified JWT email, and
//! the frontend merely mirrors that decision via the `is_admin` flag on
//! `GET /api/profile/me`.

use std::collections::HashSet;

/// The set of emails permitted to use admin-only endpoints.
///
/// Emails are normalized (trimmed, lowercased) on both ingestion and
/// lookup so the comparison matches the case-insensitive treatment the
/// profile store already applies to emails elsewhere.
#[derive(Clone, Debug, Default)]
pub struct AdminAllowlist {
    emails: HashSet<String>,
}

impl AdminAllowlist {
    /// Builds an allowlist from a comma-separated list of emails (the raw
    /// `ADMIN_EMAILS` env var value). Blank entries and surrounding
    /// whitespace are ignored, so `"a@x.com, , b@y.com"` yields two
    /// entries. An empty or whitespace-only string yields an empty
    /// allowlist — i.e. nobody is an admin, which is the correct
    /// fail-closed default when the var is unset.
    pub fn from_csv(raw: &str) -> Self {
        let emails = raw
            .split(',')
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        Self { emails }
    }

    /// Returns true if the given email is on the allowlist. Normalizes the
    /// input the same way `from_csv` normalizes stored entries.
    pub fn is_admin(&self, email: &str) -> bool {
        self.emails.contains(&email.trim().to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_allows_nobody() {
        let allow = AdminAllowlist::from_csv("");
        assert!(!allow.is_admin("ryan@rdbatch.dev"));
        assert!(!allow.is_admin(""));
    }

    #[test]
    fn whitespace_only_allows_nobody() {
        let allow = AdminAllowlist::from_csv("   ,  , ");
        assert!(!allow.is_admin("ryan@rdbatch.dev"));
    }

    #[test]
    fn single_email_is_admin() {
        let allow = AdminAllowlist::from_csv("ryan@rdbatch.dev");
        assert!(allow.is_admin("ryan@rdbatch.dev"));
        assert!(!allow.is_admin("someone@else.com"));
    }

    #[test]
    fn matching_is_case_insensitive() {
        let allow = AdminAllowlist::from_csv("Ryan@RDBatch.dev");
        assert!(allow.is_admin("ryan@rdbatch.dev"));
        assert!(allow.is_admin("RYAN@RDBATCH.DEV"));
    }

    #[test]
    fn lookup_trims_surrounding_whitespace() {
        let allow = AdminAllowlist::from_csv("ryan@rdbatch.dev");
        assert!(allow.is_admin("  ryan@rdbatch.dev  "));
    }

    #[test]
    fn multiple_emails_with_blanks_and_spaces() {
        let allow = AdminAllowlist::from_csv("a@x.com, ,  b@y.com ,");
        assert!(allow.is_admin("a@x.com"));
        assert!(allow.is_admin("b@y.com"));
        assert!(!allow.is_admin("c@z.com"));
    }
}
