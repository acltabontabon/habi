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
    let rules: [(&str, &str); 18] = [
        // https://user:secret@host -> https://***@host
        (
            r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]*:[^/\s]*@",
            "${1}***@",
        ),
        // Private keys.
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)",
            "[redacted private key]",
        ),
        (
            r"-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(-----END PGP PRIVATE KEY BLOCK-----|$)",
            "[redacted private key]",
        ),
        // Well-known token shapes.
        (
            r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b",
            "[redacted token]",
        ),
        (r"\bsk-ant-[A-Za-z0-9_\-]{20,}", "[redacted token]"),
        (r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}", "[redacted token]"),
        (r"\bAIza[0-9A-Za-z_\-]{35}", "[redacted key]"),
        (r"\bnpm_[A-Za-z0-9]{36}\b", "[redacted token]"),
        (r"\b[sr]k_live_[A-Za-z0-9]{16,}", "[redacted key]"),
        (
            r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}",
            "[redacted key]",
        ),
        (
            r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
            "[redacted token]",
        ),
        (
            r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+",
            "https://hooks.slack.com/services/[redacted]",
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
            r#"(?i)\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|secret[_-]?(?:access[_-]?)?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&]+)"#,
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

/// `https://token@host`: a credential with no password. `git@` is how SSH and
/// Git URLs say who connects, and names no one.
static URL_USER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+)@").expect("redaction pattern compiles")
});

/// Something every rule needs to find. Inspection redacts each of up to 250,000
/// dependencies, nearly all of them plain coordinates that need no more than this.
static WORTH_A_LOOK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)://|-----BEGIN|gh[pousr]_|sk-|AIza|npm_|_live_|SG\.|eyJ|github_pat_|glpat-|xox|AKIA|bearer|key|token|passw|secret",
    )
    .expect("redaction pattern compiles")
});

/// Returns `text` with credentials and token-like values replaced.
pub fn redact(text: &str) -> String {
    if !WORTH_A_LOOK.is_match(text) {
        return text.to_string();
    }
    let mut out = text.to_string();
    for rule in RULES.iter() {
        if rule.pattern.is_match(&out) {
            out = rule
                .pattern
                .replace_all(&out, rule.replacement)
                .into_owned();
        }
    }
    if URL_USER.is_match(&out) {
        out = URL_USER
            .replace_all(&out, |c: &regex::Captures<'_>| match &c[2] {
                "git" | "***" => c[0].to_string(),
                _ => format!("{}***@", &c[1]),
            })
            .into_owned();
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
            (r"-----BEGIN PGP PRIVATE KEY BLOCK-----", "a private key"),
            (r"\bsk-ant-[A-Za-z0-9_\-]{30,}", "an Anthropic API key"),
            (r"\bsk-proj-[A-Za-z0-9_\-]{30,}", "an OpenAI API key"),
            (r"\bsk-[A-Za-z0-9]{40,}", "an API key"),
            (r"\bAIza[0-9A-Za-z_\-]{35}", "a Google API key"),
            (r"\bnpm_[A-Za-z0-9]{36}\b", "an npm token"),
            (r"\b[sr]k_live_[A-Za-z0-9]{20,}", "a Stripe key"),
            (
                r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}",
                "a SendGrid key",
            ),
            (
                r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
                "a JSON Web Token",
            ),
            (
                r"https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+",
                "a Slack webhook URL",
            ),
        ]
        .into_iter()
        .map(|(p, what)| (Regex::new(p).expect("secret pattern compiles"), what))
        .collect()
    });
    // `name=value` with a secret-sounding name and a value that is not a
    // placeholder or a word: long, with both letters and digits. Only with
    // `=` (as in `.env` files and shell), never the `:` of prose and YAML docs.
    static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|secret[_-]?(?:access[_-]?)?key)\s*=\s*["']?([A-Za-z0-9/+_.\-]{12,})"#,
        )
        .expect("assignment pattern compiles")
    });
    if let Some(what) = HIGH_SIGNAL
        .iter()
        .find(|(re, _)| re.is_match(text))
        .map(|(_, what)| *what)
    {
        return Some(what);
    }
    ASSIGNMENT
        .captures_iter(text)
        .any(|c| is_real_value(&c[1]))
        .then_some("a password, key or token assigned in text")
}

/// Whether the value after `password=` and the like is plausibly a real
/// secret: letters and digits, and not an obvious placeholder.
fn is_real_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic())
        && ![
            "example",
            "xxxx",
            "your",
            "changeme",
            "placeholder",
            "redacted",
            "dummy",
            "sample",
            "token-here",
        ]
        .iter()
        .any(|p| lower.contains(p))
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

    // Built from pieces so no literal here is itself a token shape.
    fn shapes() -> Vec<(String, &'static str)> {
        let tail = ["aB3dE5fG7h", "J9kL1mN3pQ", "5rS7tU9vW1", "xY3zA5bC7d"].concat();
        let tail = tail.as_str();
        vec![
            (format!("sk-ant-api03-{tail}"), "an Anthropic API key"),
            (format!("sk-proj-{tail}"), "an OpenAI API key"),
            (format!("sk-{}", tail.replace(['-', '_'], "")), "an API key"),
            (format!("AIza{}", &tail[..35]), "a Google API key"),
            (format!("npm_{}", &tail[..36]), "an npm token"),
            (format!("{}_live_{}", "sk", &tail[..24]), "a Stripe key"),
            (format!("{}_live_{}", "rk", &tail[..24]), "a Stripe key"),
            (
                format!("SG.{}.{}", &tail[..22], &tail[..30]),
                "a SendGrid key",
            ),
            (
                format!("eyJ{}.eyJ{}.{}", &tail[..16], &tail[..20], &tail[..24]),
                "a JSON Web Token",
            ),
            (
                [
                    "https://hooks.slack.com/",
                    "services/T01ABCDEF/",
                    "B02GHIJKL/abCD3fGH5jKL7mNO9pQR1sTu",
                ]
                .concat(),
                "a Slack webhook URL",
            ),
            (
                "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY\n-----END PGP PRIVATE KEY BLOCK-----"
                    .into(),
                "a private key",
            ),
        ]
    }

    #[test]
    fn newer_token_shapes_are_found_and_redacted() {
        for (secret, what) in shapes() {
            let text = format!("config: {secret} end");
            assert_eq!(looks_secret(&text), Some(what), "{secret}");
            let out = redact(&text);
            assert!(!out.contains(&secret[8..]), "{out}");
        }
    }

    #[test]
    fn assignments_with_real_values_are_secrets_but_prose_is_not() {
        for text in [
            "API_KEY=9f8e7d6c5b4a39281716",
            "export DB_PASSWORD=\"Tr0ub4dor3xyz99\"",
            "client_secret = a1b2c3d4e5f6g7h8",
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI7K7MDENGbPxRfiCY",
        ] {
            assert!(looks_secret(text).is_some(), "{text}");
        }
        for text in [
            "password: ask the team lead",
            "Set API_KEY=your-api-key-here before running",
            "password=changeme123456",
            "secret=<value from the vault>",
            "token=$GITHUB_TOKEN",
            "SECRET_KEY=abcdefghijklmnop",
            "see the sk-learn docs and task-runner-configuration for details",
        ] {
            assert!(looks_secret(text).is_none(), "{text}");
        }
        let out = redact("DB_PASSWORD=hunter2hunter2 and MY_API_KEY: abc123");
        assert!(!out.contains("hunter2") && !out.contains("abc123"), "{out}");
    }

    #[test]
    fn secret_detection_is_high_signal() {
        assert!(looks_secret("password: ask the team lead").is_none());
        assert!(looks_secret(&["AKIA", "ABCDEFGHIJKLMNOP"].concat()).is_some());
    }

    #[test]
    fn plain_text_passes_and_what_each_rule_finds_is_still_looked_at() {
        for plain in [
            "org.springframework.boot:spring-boot-starter",
            "^18.2.0",
            "1.2.3-jre",
        ] {
            assert!(!WORTH_A_LOOK.is_match(plain), "{plain}");
            assert_eq!(redact(plain), plain);
        }
        for secret in [
            "https://u:p@host/x",
            "-----BEGIN RSA PRIVATE KEY-----\nabc",
            "ghp_0123456789012345678901234567890123456789",
            "sk-ant-abcdefghijklmnopqrstuvwxyz",
            "AIzaSyA1234567890123456789012345678901234",
            "npm_012345678901234567890123456789012345",
            "sk_live_0123456789012345",
            "SG.abcdefghijklmnopqr.abcdefghijklmnopqr",
            "eyJabcdefghij.eyJabcdefghij.abcdefghij",
            "github_pat_012345678901234567890",
            "glpat-01234567890123456789",
            "xoxb-0123456789",
            "AKIA0123456789012345",
            "Bearer abcdefghijklmnop",
            "api_key=abc",
            "PASSWORD: abc",
            "passwd=abc",
            "secret=abc",
            "token=abc",
        ] {
            assert!(WORTH_A_LOOK.is_match(secret), "{secret}");
            assert_ne!(redact(secret), secret, "{secret}");
        }
    }

    #[test]
    fn a_token_as_the_user_of_a_url_is_removed_and_git_is_kept() {
        assert_eq!(
            redact("git+https://abc123@github.com/a/b.git"),
            "git+https://***@github.com/a/b.git"
        );
        assert_eq!(
            redact("ssh://git@github.com/a/b.git"),
            "ssh://git@github.com/a/b.git"
        );
        assert_eq!(redact("https://github.com/a/b"), "https://github.com/a/b");
        assert_eq!(
            redact("https://:abc123@acme.dev/a"),
            "https://***@acme.dev/a"
        );
        assert_eq!(redact("http://host:8080/a@b"), "http://host:8080/a@b");
    }
}
