//! Version constraints in conditions.
//!
//! Requirements use Cargo/semver syntax (`>=3.2, <4`, `^18`, `~4.29`).
//! Ecosystem versions are parsed leniently: `3.2.0.RELEASE` and `6.1.0-M1`
//! are understood, missing minor/patch parts are zero.

use semver::{Prerelease, Version, VersionReq};

pub fn parse_requirement(text: &str) -> Result<VersionReq, String> {
    VersionReq::parse(text.trim()).map_err(|e| {
        format!("invalid version requirement `{text}`: {e} (use forms like `>=3.2, <4`)")
    })
}

/// Parses an ecosystem version into semver, if it has a numeric core.
pub fn lenient(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches(['v', 'V']);
    let mut numbers = Vec::new();
    let mut rest = text;
    loop {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || numbers.len() == 3 {
            break;
        }
        numbers.push(digits.parse::<u64>().ok()?);
        rest = &rest[digits.len()..];
        match rest.strip_prefix('.') {
            Some(r) if r.starts_with(|c: char| c.is_ascii_digit()) && numbers.len() < 3 => rest = r,
            _ => break,
        }
    }
    if numbers.is_empty() {
        return None;
    }
    while numbers.len() < 3 {
        numbers.push(0);
    }
    let mut version = Version::new(numbers[0], numbers[1], numbers[2]);
    let qualifier = rest.trim_start_matches(['.', '-', '+']);
    let tokens: Vec<&str> = qualifier
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    // Only recognized pre-release markers make a pre-release. Other
    // qualifiers (`32.1.3-jre`, `1.2.0.RELEASE`, `2.0.0-android`, build
    // numbers) describe a variant of the release and are ignored.
    if tokens.iter().any(|t| is_prerelease_marker(t)) {
        let cleaned = tokens
            .iter()
            .map(|t| {
                // Semver forbids leading zeros in numeric identifiers.
                if t.chars().all(|c| c.is_ascii_digit()) {
                    let trimmed = t.trim_start_matches('0');
                    if trimmed.is_empty() { "0" } else { trimmed }
                } else {
                    t
                }
            })
            .collect::<Vec<_>>()
            .join(".");
        version.pre = Prerelease::new(&cleaned).ok()?;
    }
    Some(version)
}

/// `alpha`, `beta2`, `RC1`, `CR`, `M3`, `milestone`, `SNAPSHOT`, `preview`,
/// `ea`, `dev` (case-insensitive, optionally followed by digits).
fn is_prerelease_marker(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    let letters = lower.trim_end_matches(|c: char| c.is_ascii_digit());
    let has_digits = letters.len() < lower.len();
    matches!(
        letters,
        "alpha" | "beta" | "rc" | "cr" | "milestone" | "snapshot" | "preview" | "ea" | "dev"
    ) || (letters == "m" && has_digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_parsing() {
        assert_eq!(lenient("3.2.0.RELEASE"), Some(Version::new(3, 2, 0)));
        assert_eq!(lenient("4.29"), Some(Version::new(4, 29, 0)));
        assert_eq!(lenient("v18"), Some(Version::new(18, 0, 0)));
        assert!(!lenient("6.1.0-M1").unwrap().pre.is_empty());
        assert_eq!(lenient("${x}"), None);
    }

    #[test]
    fn only_known_markers_make_a_prerelease() {
        // Variant qualifiers are not pre-releases.
        for v in [
            "32.1.3-jre",
            "33.0.0-android",
            "1.2.3.RELEASE",
            "5.0.0.Final",
        ] {
            let parsed = lenient(v).unwrap();
            assert!(parsed.pre.is_empty(), "{v} -> {parsed}");
        }
        let req = parse_requirement(">=31").unwrap();
        assert!(req.matches(&lenient("32.1.3-jre").unwrap()));
        // Recognized markers are, in any case and with numbers.
        for v in [
            "6.1.0-M1",
            "3.0.0-RC2",
            "1.0.0.Beta1",
            "2.0.0-alpha.3",
            "1.0-SNAPSHOT",
            "4.0.0.CR1",
            "21-ea",
            "1.0.0-dev.1",
            "2.0.0-preview",
            "3.0.0-milestone-01",
        ] {
            assert!(!lenient(v).unwrap().pre.is_empty(), "{v}");
        }
        assert!(!req.matches(&lenient("32.0.0-rc1").unwrap()));
    }

    #[test]
    fn requirements() {
        let req = parse_requirement(">=3, <4").unwrap();
        assert!(req.matches(&lenient("3.3.2").unwrap()));
        assert!(!req.matches(&lenient("2.7.18").unwrap()));
        assert!(parse_requirement("[3,4)").is_err());
    }
}
