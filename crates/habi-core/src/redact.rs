//! Redaction of secrets from text that may be logged, displayed in errors, or
//! exported in a diagnostic bundle.
//!
//! Redaction is a safety net, not the primary defence: Habi avoids putting
//! secrets into messages in the first place (credential-bearing URLs are
//! rejected at source registration, environment values are never logged).

use regex::Regex;
use std::sync::LazyLock;

struct Rule {
    pattern: Regex,
    replacement: &'static str,
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rules: [(&str, &str); 9] = [
        // https://user:secret@host -> https://***@host
        (
            r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@",
            "${1}***@",
        ),
        // Private keys.
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)",
            "[redacted private key]",
        ),
        // Well-known token shapes.
        (
            r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b",
            "[redacted token]",
        ),
        (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "[redacted token]"),
        (r"\bglpat-[A-Za-z0-9_\-]{16,}\b", "[redacted token]"),
        (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b", "[redacted token]"),
        (r"\bAKIA[0-9A-Z]{16}\b", "[redacted key]"),
        (
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{12,}=*",
            "Bearer [redacted]",
        ),
        // key=value style secrets in query strings, env dumps and config.
        (
            r"(?i)\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret)\s*[=:]\s*)[^\s&,;]+",
            "${1}[redacted]",
        ),
    ];
    rules
        .into_iter()
        .map(|(p, r)| Rule {
            pattern: Regex::new(p).expect("redaction pattern compiles"),
            replacement: r,
        })
        .collect()
});

/// Returns `text` with credentials and token-like values replaced.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for rule in RULES.iter() {
        if rule.pattern.is_match(&out) {
            out = rule
                .pattern
                .replace_all(&out, rule.replacement)
                .into_owned();
        }
    }
    out
}

/// True if `text` appears to contain a secret Habi would redact. Used by the
/// contribution validator to stop secrets from leaving the machine.
pub fn looks_secret(text: &str) -> Option<&'static str> {
    // The URL rule and key=value rule are too noisy for content scanning (they
    // match prose such as "password: see vault"), so only high-signal shapes
    // are used here.
    static HIGH_SIGNAL: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
            (
                r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b",
                "a GitHub token",
            ),
            (r"\bgithub_pat_[A-Za-z0-9_]{30,}\b", "a GitHub token"),
            (r"\bglpat-[A-Za-z0-9_\-]{20,}\b", "a GitLab token"),
            (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b", "a Slack token"),
            (r"\bAKIA[0-9A-Z]{16}\b", "an AWS access key"),
            (
                r"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]{6,}@",
                "a URL with an embedded password",
            ),
        ]
        .into_iter()
        .map(|(p, what)| (Regex::new(p).expect("secret pattern compiles"), what))
        .collect()
    });
    HIGH_SIGNAL
        .iter()
        .find(|(re, _)| re.is_match(text))
        .map(|(_, what)| *what)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials_in_urls() {
        assert_eq!(
            redact("fetch https://alice:s3cr3t@example.com/repo.git failed"),
            "fetch https://***@example.com/repo.git failed"
        );
        // A plain user name (ssh style) is not a secret.
        assert_eq!(
            redact("ssh://git@example.com/repo.git"),
            "ssh://git@example.com/repo.git"
        );
    }

    #[test]
    fn redacts_tokens_and_key_values() {
        let text = "token=abc123 ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abcdefghijklmnop";
        let out = redact(text);
        assert!(!out.contains("abc123"));
        assert!(!out.contains("ghp_abcdef"));
        assert!(!out.contains("abcdefghijklmnop"));
    }

    #[test]
    fn redacts_private_keys() {
        let text =
            "x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\ny";
        let out = redact(text);
        assert_eq!(out, "x\n[redacted private key]\ny");
    }

    #[test]
    fn secret_detection_is_high_signal() {
        assert!(looks_secret("password: ask the team lead").is_none());
        assert!(looks_secret("AKIAABCDEFGHIJKLMNOP").is_some());
    }
}
