//! JSON Schema validation of Habi metadata files.
//!
//! The schemas live in `/schema` at the repository root and are compiled into
//! the binary. Validation is offline: no `$ref` is ever fetched. They use a
//! small part of JSON Schema, so it is interpreted here rather than by a
//! general validator; a test fails if a schema reaches outside that part.

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

const SKILL_SCHEMA_ID: &str =
    "https://raw.githubusercontent.com/acltabontabon/habi/main/schema/habi-skill.schema.json";
const SKILL_SCHEMA: &str = include_str!("../../../../schema/habi-skill.schema.json");
const LIBRARY_SCHEMA: &str = include_str!("../../../../schema/habi-library.schema.json");

/// How many problems one file reports.
const MAX_ERRORS: usize = 10;

static SKILL: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(SKILL_SCHEMA).expect("bundled skill schema is JSON"));
static LIBRARY: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(LIBRARY_SCHEMA).expect("bundled library schema is JSON"));

/// Every `pattern` in the schemas, compiled once.
static PATTERNS: LazyLock<HashMap<&'static str, Regex>> = LazyLock::new(|| {
    fn gather(node: &'static Value, out: &mut HashMap<&'static str, Regex>) {
        match node {
            Value::Object(map) => {
                if let Some(pattern) = map.get("pattern").and_then(Value::as_str) {
                    let re = Regex::new(pattern).expect("bundled schema pattern compiles");
                    out.insert(pattern, re);
                }
                map.values().for_each(|v| gather(v, out));
            }
            Value::Array(list) => list.iter().for_each(|v| gather(v, out)),
            _ => {}
        }
    }
    let mut out = HashMap::new();
    gather(&SKILL, &mut out);
    gather(&LIBRARY, &mut out);
    out
});

/// The whole value as JSON, for a message. Long ones are cut where the message is finished.
fn shown(value: &Value) -> String {
    value.to_string()
}

fn at_key(at: &str, key: &str) -> String {
    format!("{at}/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// JSON values are equal when their numbers are, however they are written.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a == b || a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

fn has_type(value: &Value, name: &str) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => {
            value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|n| n.fract() == 0.0)
        }
        other => unreachable!("schema type {other} (tested not to happen)"),
    }
}

/// What the document at `root` has at a `$ref`, and the document it is in.
fn resolve<'a>(reference: &str, root: &'a Value) -> (&'a Value, &'a Value) {
    let (document, pointer) = reference.split_once('#').unwrap_or((reference, ""));
    let root = if document == SKILL_SCHEMA_ID {
        &*SKILL
    } else {
        root
    };
    let target = root
        .pointer(pointer)
        .expect("bundled schema reference resolves");
    (target, root)
}

struct Check<'a> {
    at: &'a str,
    value: &'a Value,
    errors: &'a mut Vec<(String, String)>,
}

impl Check<'_> {
    fn report(&mut self, message: String) {
        self.errors.push((self.at.to_string(), message));
    }
}

fn is_valid(schema: &Value, root: &Value, value: &Value) -> bool {
    let mut errors = Vec::new();
    validate(schema, root, value, "", &mut errors);
    errors.is_empty()
}

/// Checks `value` against `schema`, part of the document `root`.
fn validate(
    schema: &Value,
    root: &Value,
    value: &Value,
    at: &str,
    errors: &mut Vec<(String, String)>,
) {
    let keywords = match schema {
        Value::Object(keywords) => keywords,
        Value::Bool(true) => return,
        Value::Bool(false) => {
            errors.push((at.to_string(), format!("{} is not allowed", shown(value))));
            return;
        }
        other => unreachable!("schema {other} (tested not to happen)"),
    };
    let mut check = Check { at, value, errors };
    if let Some(reference) = keywords.get("$ref").and_then(Value::as_str) {
        let (target, document) = resolve(reference, root);
        validate(target, document, value, at, check.errors);
    }
    if let Some(name) = keywords.get("type").and_then(Value::as_str)
        && !has_type(value, name)
    {
        check.report(format!("{} is not of type \"{name}\"", shown(value)));
    }
    if let Some(expected) = keywords.get("const")
        && !same(value, expected)
    {
        check.report(format!("{} was expected", shown(expected)));
    }
    if let Some(allowed) = keywords.get("enum").and_then(Value::as_array)
        && !allowed.iter().any(|a| same(value, a))
    {
        check.report(format!(
            "{} is not one of {}",
            shown(value),
            Value::Array(allowed.clone())
        ));
    }
    if let Some(number) = value.as_f64() {
        limits_of_number(keywords, number, &mut check);
    }
    if let Some(text) = value.as_str() {
        limits_of_text(keywords, text, &mut check);
    }
    if let Some(items) = value.as_array() {
        limits_of_list(keywords, items, &mut check);
        if let Some(item) = keywords.get("items") {
            for (i, entry) in items.iter().enumerate() {
                validate(item, root, entry, &format!("{at}/{i}"), check.errors);
            }
        }
    }
    if let Some(object) = value.as_object() {
        validate_object(keywords, root, object, &mut check);
    }
    if let Some(branches) = keywords.get("oneOf").and_then(Value::as_array) {
        let matching = branches.iter().filter(|b| is_valid(b, root, value)).count();
        if matching == 0 {
            check.report(format!(
                "{} is not valid under any of the allowed forms",
                shown(value)
            ));
        } else if matching > 1 {
            check.report(format!(
                "{} is valid under more than one of the allowed forms",
                shown(value)
            ));
        }
    }
}

fn limits_of_number(keywords: &serde_json::Map<String, Value>, number: f64, check: &mut Check) {
    if let Some(minimum) = keywords.get("minimum").and_then(Value::as_f64)
        && number < minimum
    {
        check.report(format!(
            "{} is less than the minimum of {minimum}",
            shown(check.value)
        ));
    }
    if let Some(maximum) = keywords.get("maximum").and_then(Value::as_f64)
        && number > maximum
    {
        check.report(format!(
            "{} is greater than the maximum of {maximum}",
            shown(check.value)
        ));
    }
}

fn limits_of_text(keywords: &serde_json::Map<String, Value>, text: &str, check: &mut Check) {
    let length = text.chars().count() as u64;
    if let Some(min) = keywords.get("minLength").and_then(Value::as_u64)
        && length < min
    {
        check.report(format!(
            "{} is shorter than {min} characters",
            shown(check.value)
        ));
    }
    if let Some(max) = keywords.get("maxLength").and_then(Value::as_u64)
        && length > max
    {
        check.report(format!(
            "{} is longer than {max} characters",
            shown(check.value)
        ));
    }
    if let Some(pattern) = keywords.get("pattern").and_then(Value::as_str)
        && PATTERNS.get(pattern).is_some_and(|re| !re.is_match(text))
    {
        check.report(format!(
            "{} does not match \"{pattern}\"",
            shown(check.value)
        ));
    }
}

fn limits_of_list(keywords: &serde_json::Map<String, Value>, items: &[Value], check: &mut Check) {
    let count = items.len() as u64;
    if let Some(min) = keywords.get("minItems").and_then(Value::as_u64)
        && count < min
    {
        check.report(format!("{} has fewer than {min} items", shown(check.value)));
    }
    if let Some(max) = keywords.get("maxItems").and_then(Value::as_u64)
        && count > max
    {
        check.report(format!("{} has more than {max} items", shown(check.value)));
    }
    if keywords.get("uniqueItems") == Some(&Value::Bool(true))
        && items
            .iter()
            .enumerate()
            .any(|(i, a)| items.iter().take(i).any(|b| same(a, b)))
    {
        check.report(format!("{} has repeated items", shown(check.value)));
    }
}

fn validate_object(
    keywords: &serde_json::Map<String, Value>,
    root: &Value,
    object: &serde_json::Map<String, Value>,
    check: &mut Check,
) {
    if let Some(required) = keywords.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(name) {
                check.report(format!("\"{name}\" is a required property"));
            }
        }
    }
    if let Some(max) = keywords.get("maxProperties").and_then(Value::as_u64)
        && object.len() as u64 > max
    {
        check.report(format!(
            "{} has more than {max} properties",
            shown(check.value)
        ));
    }
    let properties = keywords.get("properties").and_then(Value::as_object);
    for (name, value) in object {
        let at = at_key(check.at, name);
        if let Some(names) = keywords.get("propertyNames") {
            validate(
                names,
                root,
                &Value::from(name.as_str()),
                check.at,
                check.errors,
            );
        }
        if let Some(schema) = properties.and_then(|p| p.get(name)) {
            validate(schema, root, value, &at, check.errors);
        } else if let Some(other) = keywords.get("additionalProperties") {
            if other == &Value::Bool(false) {
                check.report(format!(
                    "Additional properties are not allowed (\"{name}\" was unexpected)"
                ));
            } else {
                validate(other, root, value, &at, check.errors);
            }
        }
    }
}

fn collect(schema: &Value, value: &Value) -> Result<(), Vec<String>> {
    let mut found = Vec::new();
    validate(schema, schema, value, "", &mut found);
    if found.is_empty() {
        return Ok(());
    }
    Err(found
        .into_iter()
        .take(MAX_ERRORS)
        .map(|(at, mut msg)| {
            if msg.len() > 240 {
                // The message quotes the file, so byte 240 can be inside a character.
                msg.truncate(msg.floor_char_boundary(240));
                msg.push('…');
            }
            if at.is_empty() {
                msg
            } else {
                format!("{at}: {msg}")
            }
        })
        .collect())
}

pub fn validate_skill(value: &Value) -> Result<(), Vec<String>> {
    let mut readable = value.clone();
    if let Some(object) = readable.as_object_mut() {
        object.remove("composes");
    }
    collect(&SKILL, &readable)
}

pub fn validate_library(value: &Value) -> Result<(), Vec<String>> {
    collect(&LIBRARY, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_schemas_stay_within_what_is_interpreted() {
        const INTERPRETED: &[&str] = &[
            "$ref",
            "additionalProperties",
            "const",
            "enum",
            "items",
            "maxItems",
            "maxLength",
            "maxProperties",
            "maximum",
            "minItems",
            "minLength",
            "minimum",
            "oneOf",
            "pattern",
            "properties",
            "propertyNames",
            "required",
            "type",
            "uniqueItems",
        ];
        const NOTES: &[&str] = &[
            "$comment",
            "$defs",
            "$id",
            "$schema",
            "description",
            "title",
        ];
        fn walk(schema: &Value) {
            let Value::Object(keywords) = schema else {
                return;
            };
            for (keyword, value) in keywords {
                assert!(
                    INTERPRETED.contains(&keyword.as_str()) || NOTES.contains(&keyword.as_str()),
                    "the schema uses `{keyword}`, which library/schema.rs does not interpret"
                );
                match keyword.as_str() {
                    "properties" | "$defs" => {
                        value.as_object().unwrap().values().for_each(walk);
                    }
                    "oneOf" => value.as_array().unwrap().iter().for_each(walk),
                    "items" | "additionalProperties" | "propertyNames" => walk(value),
                    "type" => {
                        // `has_type` panics on anything else.
                        has_type(&Value::Null, value.as_str().unwrap());
                    }
                    "$ref" => {
                        let (target, _) = resolve(value.as_str().unwrap(), &SKILL);
                        assert!(target.is_object());
                    }
                    _ => {}
                }
            }
        }
        walk(&SKILL);
        walk(&LIBRARY);
    }

    #[test]
    fn says_where_and_what_is_wrong() {
        let errors = validate_library(&json!({
            "habi": 2,
            "name": "",
            "instructions": [{ "id": "UP", "title": "T", "path": "/etc/passwd", "extra": 1 }],
        }))
        .unwrap_err();
        for expected in [
            "/habi: 1 was expected",
            "/name: \"\" is shorter than 1 characters",
            "/instructions/0/id: \"UP\" does not match",
            "/instructions/0/path: \"/etc/passwd\" does not match",
            "/instructions/0: Additional properties are not allowed (\"extra\" was unexpected)",
        ] {
            assert!(
                errors.iter().any(|e| e.starts_with(expected)),
                "{expected} is not in {errors:?}"
            );
        }
        assert_eq!(
            validate_library(&json!({})).unwrap_err(),
            ["\"habi\" is a required property"]
        );
    }

    #[test]
    fn numbers_are_equal_however_they_are_written() {
        assert!(validate_library(&json!({ "habi": 1.0 })).is_ok());
        assert!(
            validate_library(&json!({
                "habi": 1,
                "instructions": [{ "id": "a", "title": "T", "path": "a.md", "priority": 5.0 }],
            }))
            .is_ok()
        );
    }

    #[test]
    fn a_long_message_is_cut_on_a_character() {
        let errors = validate_library(&json!({ "habi": 1, "name": "é".repeat(500) })).unwrap_err();
        assert!(errors[0].ends_with('…'), "{errors:?}");
    }

    #[test]
    fn at_most_ten_problems_are_reported() {
        let entries: Vec<Value> = (0..30).map(|_| json!({})).collect();
        let errors = validate_library(&json!({ "habi": 1, "instructions": entries })).unwrap_err();
        assert_eq!(errors.len(), MAX_ERRORS);
    }
}
