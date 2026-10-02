//! Project-level MCP configuration for each client.
//!
//! Habi only adds a server entry that is missing and only removes an entry
//! that is unchanged since Habi added it. Unrelated keys and formatting are
//! preserved (JSON key order via `preserve_order`; TOML via `toml_edit`).
//! Secrets are never written: environment values are references that each
//! client resolves itself, using its own syntax (see `docs/compatibility.md`):
//! - Claude Code `.mcp.json`: `${VAR}`
//! - Cursor `.cursor/mcp.json`: `${env:VAR}`
//! - Codex `.codex/config.toml`: `env_vars = ["VAR"]` / `bearer_token_env_var`
//!
//! "Configured" means an entry with that name exists in the file. It does not
//! mean the server starts, is authenticated, or is authorized.

use super::ClientId;
use crate::error::{HabiError, Result};
use crate::fsutil::sha256;
use crate::library::model::McpServerSpec;
use serde_json::{Map, Value, json};

pub fn config_path(client: ClientId) -> &'static str {
    match client {
        ClientId::ClaudeCode => ".mcp.json",
        ClientId::Cursor => ".cursor/mcp.json",
        ClientId::Codex => ".codex/config.toml",
    }
}

/// `${VAR}` -> `VAR`.
fn var_name(reference: &str) -> Option<&str> {
    reference.strip_prefix("${")?.strip_suffix('}')
}

/// Notes explaining how the shared definition was translated for a client.
pub fn translation_notes(client: ClientId, spec: &McpServerSpec) -> Vec<String> {
    let mut notes = Vec::new();
    let has_env = match spec {
        McpServerSpec::Stdio { env, .. } => !env.is_empty(),
        McpServerSpec::Http {
            bearer_token_env, ..
        } => bearer_token_env.is_some(),
    };
    match client {
        ClientId::ClaudeCode => {
            if has_env {
                notes.push(
                    "Claude Code expands ${VAR} from your environment when it starts the server."
                        .into(),
                );
            }
            notes.push(
                "Claude Code asks you to approve project MCP servers before using them.".into(),
            );
        }
        ClientId::Cursor => {
            if has_env {
                notes.push(
                    "Written as ${env:VAR}, Cursor's syntax for reading your environment.".into(),
                );
            }
        }
        ClientId::Codex => {
            if has_env {
                notes.push("Codex has no ${VAR} expansion; Habi lists the variable names so Codex forwards them from your environment.".into());
            }
            notes.push("Codex reads project .codex/config.toml only for projects you have marked as trusted.".into());
        }
    }
    notes
}

fn json_entry(client: ClientId, spec: &McpServerSpec) -> Value {
    match (client, spec) {
        (ClientId::Codex, _) => unreachable!("Codex uses TOML"),
        (_, McpServerSpec::Stdio { command, args, env }) => {
            let mut entry = Map::new();
            if client == ClientId::Cursor {
                entry.insert("type".into(), json!("stdio"));
            }
            entry.insert("command".into(), json!(command));
            if !args.is_empty() {
                entry.insert("args".into(), json!(args));
            }
            if !env.is_empty() {
                let mut e = Map::new();
                for (k, v) in env {
                    let value = match (client, var_name(v)) {
                        (ClientId::Cursor, Some(name)) => format!("${{env:{name}}}"),
                        _ => v.clone(),
                    };
                    e.insert(k.clone(), json!(value));
                }
                entry.insert("env".into(), Value::Object(e));
            }
            Value::Object(entry)
        }
        (
            _,
            McpServerSpec::Http {
                url,
                bearer_token_env,
            },
        ) => {
            let mut entry = Map::new();
            if client == ClientId::ClaudeCode {
                entry.insert("type".into(), json!("http"));
            }
            entry.insert("url".into(), json!(url));
            if let Some(var) = bearer_token_env {
                let reference = match client {
                    ClientId::Cursor => format!("${{env:{var}}}"),
                    _ => format!("${{{var}}}"),
                };
                entry.insert(
                    "headers".into(),
                    json!({ "Authorization": format!("Bearer {reference}") }),
                );
            }
            Value::Object(entry)
        }
    }
}

fn toml_entry(spec: &McpServerSpec) -> toml_edit::Table {
    let mut table = toml_edit::Table::new();
    match spec {
        McpServerSpec::Stdio { command, args, env } => {
            table["command"] = toml_edit::value(command.as_str());
            if !args.is_empty() {
                let mut arr = toml_edit::Array::new();
                for a in args {
                    arr.push(a.as_str());
                }
                table["args"] = toml_edit::value(arr);
            }
            let vars: Vec<&str> = env.values().filter_map(|v| var_name(v)).collect();
            if !vars.is_empty() {
                let mut arr = toml_edit::Array::new();
                for v in vars {
                    arr.push(v);
                }
                table["env_vars"] = toml_edit::value(arr);
            }
        }
        McpServerSpec::Http {
            url,
            bearer_token_env,
        } => {
            table["url"] = toml_edit::value(url.as_str());
            if let Some(var) = bearer_token_env {
                table["bearer_token_env_var"] = toml_edit::value(var.as_str());
            }
        }
    }
    table
}

/// Rejects JSON that would not survive a parse/serialize round trip
/// unchanged in meaning: duplicate keys (serde keeps only the last) and
/// numbers whose text would change (exponents, very large integers, `1.50`).
fn check_fidelity(bytes: &[u8]) -> std::result::Result<(), String> {
    use serde::de::{DeserializeSeed, Deserializer, Error as _, MapAccess, SeqAccess, Visitor};
    struct NoDup;
    impl<'de> DeserializeSeed<'de> for NoDup {
        type Value = ();
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
            d.deserialize_any(NoDup)
        }
    }
    impl<'de> Visitor<'de> for NoDup {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<(), A::Error> {
            let mut seen = std::collections::HashSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !seen.insert(key.clone()) {
                    return Err(A::Error::custom(format!("duplicate key `{key}`")));
                }
                map.next_value_seed(NoDup)?;
            }
            Ok(())
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<(), A::Error> {
            while seq.next_element_seed(NoDup)?.is_some() {}
            Ok(())
        }
        fn visit_bool<E>(self, _: bool) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_i64<E>(self, _: i64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_u64<E>(self, _: u64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_f64<E>(self, _: f64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_str<E>(self, _: &str) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_unit<E>(self) -> std::result::Result<(), E> {
            Ok(())
        }
    }
    let mut de = serde_json::Deserializer::from_slice(bytes);
    NoDup.deserialize(&mut de).map_err(|e| e.to_string())?;

    // Every number token must re-serialize to the same text.
    let text = String::from_utf8_lossy(bytes);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == '-' || c.is_ascii_digit() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit() || matches!(chars[i], '-' | '+' | '.' | 'e' | 'E'))
            {
                i += 1;
            }
            let token: String = chars[start..i].iter().collect();
            let same = serde_json::from_str::<serde_json::Number>(&token)
                .map(|n| n.to_string() == token)
                .unwrap_or(false);
            if !same {
                return Err(format!("the number `{token}` cannot be rewritten exactly"));
            }
            continue;
        }
        i += 1;
    }
    Ok(())
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Splits off a UTF-8 byte order mark (some Windows editors add one).
fn split_bom(bytes: &[u8]) -> (bool, &[u8]) {
    match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    }
}

/// Gives rewritten content the byte order mark and line endings of the
/// file it replaces: a BOM is kept, and a file that uses only CRLF stays CRLF.
fn like_original(original: Option<&[u8]>, text: String) -> Vec<u8> {
    let (bom, body) = split_bom(original.unwrap_or_default());
    let crlf_lines = body.windows(2).filter(|w| *w == b"\r\n").count();
    let all_crlf = crlf_lines > 0 && crlf_lines == body.iter().filter(|b| **b == b'\n').count();
    let text = if all_crlf {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text
    };
    let mut out = Vec::with_capacity(text.len() + 3);
    if bom {
        out.extend_from_slice(BOM);
    }
    out.extend_from_slice(text.as_bytes());
    out
}

fn parse_json(existing: Option<&[u8]>, file: &str) -> Result<Value> {
    match existing.map(|b| split_bom(b).1) {
        None => Ok(json!({})),
        Some(bytes) if bytes.iter().all(|b| b.is_ascii_whitespace()) => Ok(json!({})),
        Some(bytes) => {
            check_fidelity(bytes).map_err(|why| {
                HabiError::Conflict(format!(
                    "{file} cannot be edited without changing it ({why}); Habi will not modify it"
                ))
            })?;
            let v: Value = serde_json::from_slice(bytes).map_err(|e| {
                HabiError::Conflict(format!(
                    "{file} is not valid JSON ({e}); Habi will not modify it"
                ))
            })?;
            if !v.is_object() {
                return Err(HabiError::Conflict(format!(
                    "{file} is not a JSON object; Habi will not modify it"
                )));
            }
            Ok(v)
        }
    }
}

fn parse_toml(existing: Option<&[u8]>, file: &str) -> Result<toml_edit::DocumentMut> {
    let text = match existing.map(|b| split_bom(b).1) {
        None => String::new(),
        Some(b) => String::from_utf8(b.to_vec())
            .map_err(|_| HabiError::Conflict(format!("{file} is not UTF-8")))?,
    };
    text.parse::<toml_edit::DocumentMut>().map_err(|e| {
        HabiError::Conflict(format!(
            "{file} is not valid TOML ({e}); Habi will not modify it"
        ))
    })
}

/// Digest of a TOML entry as text, independent of line-ending style.
fn toml_digest(entry: &str) -> String {
    sha256(entry.replace("\r\n", "\n").trim().as_bytes())
}

/// Digest of the named entry as it currently appears, if present.
pub fn entry_digest(
    client: ClientId,
    existing: Option<&[u8]>,
    server: &str,
) -> Result<Option<String>> {
    let file = config_path(client);
    match client {
        ClientId::Codex => {
            let doc = parse_toml(existing, file)?;
            Ok(doc
                .get("mcp_servers")
                .and_then(|t| t.get(server))
                .map(|item| toml_digest(&item.to_string())))
        }
        _ => {
            let v = parse_json(existing, file)?;
            Ok(v.get("mcpServers")
                .and_then(|s| s.get(server))
                .map(|entry| sha256(entry.to_string().as_bytes())))
        }
    }
}

pub fn is_configured(client: ClientId, existing: Option<&[u8]>, server: &str) -> Result<bool> {
    Ok(entry_digest(client, existing, server)?.is_some())
}

/// Adds the server entry. Returns the new file content and the entry digest.
pub fn insert(
    client: ClientId,
    existing: Option<&[u8]>,
    server: &str,
    spec: &McpServerSpec,
) -> Result<(Vec<u8>, String)> {
    let file = config_path(client);
    if is_configured(client, existing, server)? {
        return Err(HabiError::Conflict(format!(
            "{file} already configures `{server}`"
        )));
    }
    match client {
        ClientId::Codex => {
            let mut doc = parse_toml(existing, file)?;
            if doc.get("mcp_servers").is_none() {
                let mut t = toml_edit::Table::new();
                t.set_implicit(true);
                doc["mcp_servers"] = toml_edit::Item::Table(t);
            }
            let servers = doc["mcp_servers"].as_table_mut().ok_or_else(|| {
                HabiError::Conflict(format!("`mcp_servers` in {file} is not a table"))
            })?;
            servers.insert(server, toml_edit::Item::Table(toml_entry(spec)));
            let digest = toml_digest(&doc["mcp_servers"][server].to_string());
            Ok((like_original(existing, doc.to_string()), digest))
        }
        _ => {
            let mut v = parse_json(existing, file)?;
            let obj = v.as_object_mut().expect("checked object");
            let servers = obj
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| {
                    HabiError::Conflict(format!("`mcpServers` in {file} is not an object"))
                })?;
            let entry = json_entry(client, spec);
            let digest = sha256(entry.to_string().as_bytes());
            servers.insert(server.to_string(), entry);
            Ok((like_original(existing, json_text(&v)), digest))
        }
    }
}

fn json_text(v: &Value) -> String {
    let mut text = serde_json::to_string_pretty(v).expect("json serializes");
    text.push('\n');
    text
}

/// Digest of the entry Habi would write for `spec`.
pub fn spec_digest(client: ClientId, server: &str, spec: &McpServerSpec) -> Result<String> {
    insert(client, None, server, spec).map(|(_, digest)| digest)
}

/// Replaces the entry with the definition `spec`, if the entry still matches
/// `expected_digest` (what Habi wrote). Returns `None` if the entry is missing
/// or was changed by someone else, so it is left alone. The entry keeps its
/// place in the file.
pub fn replace(
    client: ClientId,
    existing: &[u8],
    server: &str,
    spec: &McpServerSpec,
    expected_digest: &str,
) -> Result<Option<(Vec<u8>, String)>> {
    let file = config_path(client);
    if entry_digest(client, Some(existing), server)?.as_deref() != Some(expected_digest) {
        return Ok(None);
    }
    let text = match client {
        ClientId::Codex => {
            let mut doc = parse_toml(Some(existing), file)?;
            let Some(table) = doc
                .get_mut("mcp_servers")
                .and_then(|t| t.get_mut(server))
                .and_then(|t| t.as_table_mut())
            else {
                return Ok(None);
            };
            table.clear();
            for (key, value) in toml_entry(spec).iter() {
                table.insert(key, value.clone());
            }
            doc.to_string()
        }
        _ => {
            let mut v = parse_json(Some(existing), file)?;
            let Some(entry) = v.get_mut("mcpServers").and_then(|s| s.get_mut(server)) else {
                return Ok(None);
            };
            *entry = json_entry(client, spec);
            json_text(&v)
        }
    };
    let out = like_original(Some(existing), text);
    let digest = entry_digest(client, Some(&out), server)?
        .ok_or_else(|| HabiError::Internal(format!("could not update `{server}` in {file}")))?;
    Ok(Some((out, digest)))
}

/// True if a configuration file has nothing left in it but an empty server
/// list (`{}` / `{"mcpServers": {}}`, or an empty TOML document), so a file
/// Habi created can be deleted instead of being left behind empty.
pub fn is_empty_config(client: ClientId, content: &[u8]) -> bool {
    let file = config_path(client);
    match client {
        ClientId::Codex => {
            let Ok(mut doc) = parse_toml(Some(content), file) else {
                return false;
            };
            if doc
                .get("mcp_servers")
                .and_then(|t| t.as_table())
                .is_some_and(|t| t.is_empty())
            {
                doc.remove("mcp_servers");
            }
            doc.to_string().trim().is_empty()
        }
        _ => match parse_json(Some(content), file) {
            Ok(Value::Object(obj)) => obj
                .iter()
                .all(|(k, v)| k == "mcpServers" && v.as_object().is_some_and(|s| s.is_empty())),
            _ => false,
        },
    }
}

/// Removes the entry if it still matches `expected_digest`. Returns `None`
/// if the entry was changed by someone else (the caller leaves it and says
/// so). The file itself is never deleted here; see `is_empty_config`.
pub fn remove(
    client: ClientId,
    existing: &[u8],
    server: &str,
    expected_digest: &str,
) -> Result<Option<Vec<u8>>> {
    let file = config_path(client);
    match entry_digest(client, Some(existing), server)? {
        None => return Ok(Some(existing.to_vec())),
        Some(d) if d != expected_digest => return Ok(None),
        Some(_) => {}
    }
    match client {
        ClientId::Codex => {
            let mut doc = parse_toml(Some(existing), file)?;
            if let Some(t) = doc.get_mut("mcp_servers").and_then(|t| t.as_table_mut()) {
                t.remove(server);
            }
            Ok(Some(like_original(Some(existing), doc.to_string())))
        }
        _ => {
            let mut v = parse_json(Some(existing), file)?;
            if let Some(s) = v.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
                s.remove(server);
            }
            Ok(Some(like_original(Some(existing), json_text(&v))))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn stdio() -> McpServerSpec {
        McpServerSpec::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()],
            env: BTreeMap::from([("GITHUB_TOKEN".into(), "${GITHUB_TOKEN}".into())]),
        }
    }

    #[test]
    fn preserves_unrelated_json_keys_and_order() {
        let existing =
            br#"{ "zeta": 1, "mcpServers": { "local": { "command": "x" } }, "alpha": true }"#;
        let (out, digest) =
            insert(ClientId::ClaudeCode, Some(existing), "github", &stdio()).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.find("zeta").unwrap() < text.find("alpha").unwrap());
        assert!(text.contains("\"local\""));
        assert!(text.contains("${GITHUB_TOKEN}"));
        let removed = remove(ClientId::ClaudeCode, &out, "github", &digest)
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_slice(&removed).unwrap();
        assert!(v["mcpServers"].get("github").is_none());
        assert!(v["mcpServers"].get("local").is_some());
    }

    #[test]
    fn byte_order_marks_and_crlf_are_accepted_and_kept() {
        let existing = b"\xEF\xBB\xBF{\r\n  \"mcpServers\": {}\r\n}\r\n";
        let (out, digest) =
            insert(ClientId::ClaudeCode, Some(existing), "github", &stdio()).unwrap();
        assert!(out.starts_with(BOM), "BOM kept");
        let text = String::from_utf8(out[3..].to_vec()).unwrap();
        assert_eq!(text.matches('\n').count(), text.matches("\r\n").count());
        assert!(is_configured(ClientId::ClaudeCode, Some(&out), "github").unwrap());
        let removed = remove(ClientId::ClaudeCode, &out, "github", &digest)
            .unwrap()
            .unwrap();
        assert!(removed.starts_with(BOM));
        assert!(is_empty_config(ClientId::ClaudeCode, &removed));

        let toml = b"\xEF\xBB\xBFmodel = \"o4\"\r\n";
        let (out, digest) = insert(ClientId::Codex, Some(toml), "github", &stdio()).unwrap();
        assert!(out.starts_with(BOM));
        let text = String::from_utf8(out[3..].to_vec()).unwrap();
        assert_eq!(text.matches('\n').count(), text.matches("\r\n").count());
        assert_eq!(
            entry_digest(ClientId::Codex, Some(&out), "github").unwrap(),
            Some(digest)
        );
    }

    #[test]
    fn empty_configs_are_recognized() {
        assert!(is_empty_config(ClientId::Cursor, b"{\"mcpServers\": {}}\n"));
        assert!(is_empty_config(ClientId::Cursor, b"{}"));
        assert!(!is_empty_config(
            ClientId::Cursor,
            b"{\"mcpServers\": {}, \"x\": 1}"
        ));
        assert!(!is_empty_config(
            ClientId::Cursor,
            b"{\"mcpServers\": {\"a\": {}}}"
        ));
        assert!(is_empty_config(ClientId::Codex, b""));
        assert!(is_empty_config(ClientId::Codex, b"[mcp_servers]\n"));
        assert!(!is_empty_config(ClientId::Codex, b"# my notes\n"));
        assert!(!is_empty_config(ClientId::Codex, b"model = \"o4\"\n"));
        let (out, digest) = insert(ClientId::Codex, None, "github", &stdio()).unwrap();
        let removed = remove(ClientId::Codex, &out, "github", &digest)
            .unwrap()
            .unwrap();
        assert!(is_empty_config(ClientId::Codex, &removed));
    }

    #[test]
    fn replace_updates_unchanged_entries_in_place() {
        let newer = McpServerSpec::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-github@2".into()],
            env: BTreeMap::new(),
        };
        for client in ClientId::ALL {
            let (one, d1) = insert(client, None, "aaa", &stdio()).unwrap();
            let (two, d2) = insert(client, Some(&one), "github", &stdio()).unwrap();
            let (three, _) = insert(client, Some(&two), "zzz", &stdio()).unwrap();
            let (out, digest) = replace(client, &three, "github", &newer, &d2)
                .unwrap()
                .unwrap();
            assert_eq!(digest, spec_digest(client, "github", &newer).unwrap());
            let text = String::from_utf8(out.clone()).unwrap();
            assert!(text.contains("server-github@2"), "{text}");
            let (a, g, z) = (
                text.find("aaa").unwrap(),
                text.find("github").unwrap(),
                text.find("zzz").unwrap(),
            );
            assert!(a < g && g < z, "entry keeps its place: {text}");
            assert_eq!(
                entry_digest(client, Some(&out), "aaa").unwrap(),
                Some(d1.clone())
            );
            // An entry someone edited is left alone.
            assert!(
                replace(client, &three, "github", &newer, "sha256:other")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn refuses_lossy_json_rewrites() {
        for bad in [
            br#"{"mcpServers": {}, "a": 1, "a": 2}"#.as_slice(),
            br#"{"big": 123456789012345678901234567890}"#.as_slice(),
            br#"{"e": 1e2}"#.as_slice(),
            br#"{"f": 1.50}"#.as_slice(),
        ] {
            assert!(insert(ClientId::ClaudeCode, Some(bad), "github", &stdio()).is_err());
        }
        let fine = br#"{"n": -12, "f": 1.5, "s": "1e2 \" 99999999999999999999"}"#;
        assert!(insert(ClientId::ClaudeCode, Some(fine), "github", &stdio()).is_ok());
    }

    #[test]
    fn cursor_uses_its_env_syntax() {
        let (out, _) = insert(ClientId::Cursor, None, "github", &stdio()).unwrap();
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            v["mcpServers"]["github"]["env"]["GITHUB_TOKEN"],
            "${env:GITHUB_TOKEN}"
        );
        assert_eq!(v["mcpServers"]["github"]["type"], "stdio");
    }

    #[test]
    fn codex_toml_preserves_formatting_and_forwards_env_names() {
        let existing =
            b"# my settings\nmodel = \"o4\"\n\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n";
        let (out, digest) = insert(ClientId::Codex, Some(existing), "github", &stdio()).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.starts_with("# my settings\nmodel = \"o4\"\n"));
        assert!(text.contains("[mcp_servers.github]"));
        assert!(text.contains("env_vars = [\"GITHUB_TOKEN\"]"));
        assert!(!text.contains("${"));
        let removed = String::from_utf8(
            remove(ClientId::Codex, &out, "github", &digest)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(removed.contains("[mcp_servers.docs]"));
        assert!(!removed.contains("github"));
    }

    #[test]
    fn refuses_to_touch_invalid_or_modified_config() {
        assert!(insert(ClientId::ClaudeCode, Some(b"{ not json"), "x", &stdio()).is_err());
        let (out, _) = insert(ClientId::ClaudeCode, None, "github", &stdio()).unwrap();
        assert!(insert(ClientId::ClaudeCode, Some(&out), "github", &stdio()).is_err());
        let edited = String::from_utf8(out)
            .unwrap()
            .replace("server-github", "server-github@1.2");
        assert!(
            remove(
                ClientId::ClaudeCode,
                edited.as_bytes(),
                "github",
                "sha256:other"
            )
            .unwrap()
            .is_none()
        );
    }
}
