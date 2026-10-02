//! JSON Schema validation of Habi metadata files.
//!
//! The schemas live in `/schema` at the repository root and are compiled into
//! the binary. Validation is offline: no `$ref` is ever fetched.

use jsonschema::Validator;
use serde_json::Value;
use std::sync::LazyLock;

pub const SKILL_SCHEMA_ID: &str =
    "https://raw.githubusercontent.com/acltabontabon/habi/main/schema/habi-skill.schema.json";
pub const SKILL_SCHEMA: &str = include_str!("../../../../schema/habi-skill.schema.json");
pub const LIBRARY_SCHEMA: &str = include_str!("../../../../schema/habi-library.schema.json");

static SKILL_VALUE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(SKILL_SCHEMA).expect("bundled skill schema is JSON"));
static LIBRARY_VALUE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(LIBRARY_SCHEMA).expect("bundled library schema is JSON"));

static SKILL: LazyLock<Validator> = LazyLock::new(|| {
    jsonschema::options()
        .build(&SKILL_VALUE)
        .expect("bundled skill schema compiles")
});

static LIBRARY: LazyLock<Validator> = LazyLock::new(|| {
    let registry = jsonschema::Registry::new()
        .add(SKILL_SCHEMA_ID, &*SKILL_VALUE)
        .expect("valid schema id")
        .prepare()
        .expect("schema registry");
    // The registry is only needed while compiling; the validator owns what it needs.
    let registry: &'static jsonschema::Registry<'static> = Box::leak(Box::new(registry));
    jsonschema::options()
        .with_registry(registry)
        .build(&LIBRARY_VALUE)
        .expect("bundled library schema compiles")
});

fn collect(validator: &Validator, value: &Value) -> Result<(), Vec<String>> {
    let errors: Vec<String> = validator
        .iter_errors(value)
        .take(10)
        .map(|e| {
            let at = e.instance_path().to_string();
            let mut msg = e.to_string();
            if msg.len() > 240 {
                msg.truncate(240);
                msg.push('…');
            }
            if at.is_empty() {
                msg
            } else {
                format!("{at}: {msg}")
            }
        })
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn validate_skill(value: &Value) -> Result<(), Vec<String>> {
    collect(&SKILL, value)
}

pub fn validate_library(value: &Value) -> Result<(), Vec<String>> {
    collect(&LIBRARY, value)
}
