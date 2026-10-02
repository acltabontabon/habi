//! Timestamps as RFC 3339 strings (UTC).

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub fn now() -> String {
    format(OffsetDateTime::now_utc())
}

pub fn format(t: OffsetDateTime) -> String {
    t.replace_nanosecond(0)
        .unwrap_or(t)
        .format(&Rfc3339)
        .unwrap_or_default()
}

pub fn parse(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// Seconds between two RFC 3339 timestamps, if both parse.
pub fn seconds_between(earlier: &str, later: &str) -> Option<i64> {
    Some((parse(later)? - parse(earlier)?).whole_seconds())
}
