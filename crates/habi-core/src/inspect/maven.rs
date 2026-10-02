//! Static reading of Maven `pom.xml` files.
//!
//! Habi never runs Maven. It reads POMs in the repository, resolves `${...}`
//! properties and `dependencyManagement` through parents that exist locally,
//! and reports anything it cannot see (external parents, imported BOMs,
//! undefined properties) as unresolved rather than guessing.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use std::collections::{BTreeMap, HashMap, HashSet};

const DETECTOR: &str = "maven";

/// External parents known to declare no `<dependencies>` of their own (they
/// only manage versions), so inheriting from them does not hide dependencies.
const VERSION_ONLY_PARENTS: &[&str] = &[
    "org.springframework.boot:spring-boot-starter-parent",
    "org.springframework.boot:spring-boot-dependencies",
];

#[derive(Debug, Clone)]
pub struct DepDecl {
    pub group: String,
    pub artifact: String,
    pub version: Option<String>,
    pub scope: Option<String>,
    pub kind: Option<String>,
    pub line: u32,
    pub profile: Option<String>,
}

impl DepDecl {
    fn coordinate(&self) -> String {
        format!("{}:{}", self.group, self.artifact)
    }
}

#[derive(Debug, Clone)]
pub struct ParentRef {
    pub group: String,
    pub artifact: String,
    pub version: Option<String>,
    pub relative_path: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone)]
pub struct Pom {
    /// Repository-relative path of the pom.xml.
    pub path: String,
    pub module: String,
    pub group: Option<String>,
    pub artifact: Option<String>,
    pub version: Option<String>,
    pub parent: Option<ParentRef>,
    pub properties: BTreeMap<String, String>,
    pub modules: Vec<String>,
    pub dependencies: Vec<DepDecl>,
    pub managed: Vec<DepDecl>,
    pub plugins: Vec<DepDecl>,
}

fn children<'a, 'i>(
    node: roxmltree::Node<'a, 'i>,
    name: &'a str,
) -> impl Iterator<Item = roxmltree::Node<'a, 'i>> + 'a {
    node.children()
        .filter(move |n| n.is_element() && n.tag_name().name() == name)
}

fn child<'a, 'i>(node: roxmltree::Node<'a, 'i>, name: &'a str) -> Option<roxmltree::Node<'a, 'i>> {
    children(node, name).next()
}

fn child_text(node: roxmltree::Node, name: &str) -> Option<String> {
    child(node, name)
        .and_then(|n| n.text())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn line_of(doc: &roxmltree::Document, node: roxmltree::Node) -> u32 {
    doc.text_pos_at(node.range().start).row
}

fn read_decls(
    doc: &roxmltree::Document,
    container: Option<roxmltree::Node>,
    element: &str,
    profile: Option<&str>,
) -> Vec<DepDecl> {
    let Some(container) = container else {
        return Vec::new();
    };
    children(container, element)
        .filter_map(|d| {
            Some(DepDecl {
                // Plugins default to the org.apache.maven.plugins group.
                group: child_text(d, "groupId").or_else(|| {
                    (element == "plugin").then(|| "org.apache.maven.plugins".to_string())
                })?,
                artifact: child_text(d, "artifactId")?,
                version: child_text(d, "version"),
                scope: child_text(d, "scope"),
                kind: child_text(d, "type"),
                line: line_of(doc, d),
                profile: profile.map(str::to_string),
            })
        })
        .collect()
}

/// Parses one POM. Errors are returned as human-readable strings.
pub fn parse(path: &str, module: &str, text: &str) -> Result<Pom, String> {
    let doc = roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 200_000,
            ..Default::default()
        },
    )
    .map_err(|e| format!("could not parse {path}: {e}"))?;
    let project = doc.root_element();
    if project.tag_name().name() != "project" {
        return Err(format!("{path} has no <project> root element"));
    }

    let parent = child(project, "parent").and_then(|p| {
        Some(ParentRef {
            group: child_text(p, "groupId")?,
            artifact: child_text(p, "artifactId")?,
            version: child_text(p, "version"),
            relative_path: child(p, "relativePath")
                .map(|n| n.text().unwrap_or("").trim().to_string()),
            line: line_of(&doc, p),
        })
    });

    let mut properties = BTreeMap::new();
    if let Some(props) = child(project, "properties") {
        for p in props.children().filter(|n| n.is_element()) {
            properties.insert(
                p.tag_name().name().to_string(),
                p.text().unwrap_or("").trim().to_string(),
            );
        }
    }

    let modules = child(project, "modules")
        .map(|m| {
            children(m, "module")
                .filter_map(|n| n.text().map(|t| t.trim().to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut dependencies = read_decls(&doc, child(project, "dependencies"), "dependency", None);
    let managed = read_decls(
        &doc,
        child(project, "dependencyManagement").and_then(|n| child(n, "dependencies")),
        "dependency",
        None,
    );
    let mut plugins = read_decls(
        &doc,
        child(project, "build").and_then(|n| child(n, "plugins")),
        "plugin",
        None,
    );

    if let Some(profiles) = child(project, "profiles") {
        for profile in children(profiles, "profile") {
            let id = child_text(profile, "id").unwrap_or_else(|| "unnamed".into());
            dependencies.extend(read_decls(
                &doc,
                child(profile, "dependencies"),
                "dependency",
                Some(&id),
            ));
            plugins.extend(read_decls(
                &doc,
                child(profile, "build").and_then(|n| child(n, "plugins")),
                "plugin",
                Some(&id),
            ));
        }
    }

    Ok(Pom {
        path: path.to_string(),
        module: module.to_string(),
        group: child_text(project, "groupId"),
        artifact: child_text(project, "artifactId"),
        version: child_text(project, "version"),
        parent,
        properties,
        modules,
        dependencies,
        managed,
        plugins,
    })
}

/// Normalizes `a/b/../c` style paths inside the repository. Returns `None`
/// if the path escapes the repository root.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

enum ParentLink {
    None,
    Local(usize),
    External {
        coordinate: String,
        version: Option<String>,
    },
}

struct Resolver<'a> {
    poms: &'a [Pom],
    by_path: HashMap<&'a str, usize>,
}

impl<'a> Resolver<'a> {
    fn new(poms: &'a [Pom]) -> Self {
        let by_path = poms
            .iter()
            .enumerate()
            .map(|(i, p)| (p.path.as_str(), i))
            .collect();
        Resolver { poms, by_path }
    }

    fn parent_of(&self, index: usize) -> ParentLink {
        let pom = &self.poms[index];
        let Some(parent) = &pom.parent else {
            return ParentLink::None;
        };
        let relative = match parent.relative_path.as_deref() {
            // An empty <relativePath/> means "do not look locally".
            Some("") => None,
            Some(rel) => Some(rel.to_string()),
            None => Some("../pom.xml".to_string()),
        };
        if let Some(rel) = relative {
            let rel = if rel.ends_with(".xml") {
                rel
            } else {
                format!("{}/pom.xml", rel.trim_end_matches('/'))
            };
            let joined = format!("{}/{}", dir_of(&pom.path), rel);
            if let Some(candidate) = normalize(&joined)
                && let Some(&i) = self.by_path.get(candidate.as_str())
            {
                let p = &self.poms[i];
                let group = p.group.as_ref().or(p.parent.as_ref().map(|x| &x.group));
                if group == Some(&parent.group) && p.artifact.as_ref() == Some(&parent.artifact) {
                    return ParentLink::Local(i);
                }
            }
        }
        ParentLink::External {
            coordinate: format!("{}:{}", parent.group, parent.artifact),
            version: parent.version.clone(),
        }
    }

    /// Local parent chain starting with `index` itself, plus the external
    /// parent at the end, if any. Bounded and cycle-safe.
    fn chain(&self, index: usize) -> (Vec<usize>, Option<(String, Option<String>)>) {
        let mut chain = vec![index];
        let mut seen = HashSet::from([index]);
        let mut current = index;
        for _ in 0..16 {
            match self.parent_of(current) {
                ParentLink::None => return (chain, None),
                ParentLink::External {
                    coordinate,
                    version,
                } => return (chain, Some((coordinate, version))),
                ParentLink::Local(p) => {
                    if !seen.insert(p) {
                        return (chain, None);
                    }
                    chain.push(p);
                    current = p;
                }
            }
        }
        (chain, None)
    }

    fn properties(&self, chain: &[usize]) -> HashMap<String, String> {
        let mut props = HashMap::new();
        // Apply from the farthest ancestor so children override.
        for &i in chain.iter().rev() {
            let pom = &self.poms[i];
            for (k, v) in &pom.properties {
                props.insert(k.clone(), v.clone());
            }
        }
        let me = &self.poms[chain[0]];
        let version = me
            .version
            .clone()
            .or_else(|| me.parent.as_ref().and_then(|p| p.version.clone()));
        if let Some(v) = version {
            props.insert("project.version".into(), v.clone());
            props.insert("pom.version".into(), v);
        }
        if let Some(pv) = me.parent.as_ref().and_then(|p| p.version.clone()) {
            props.insert("project.parent.version".into(), pv);
        }
        if let Some(g) = me
            .group
            .clone()
            .or_else(|| me.parent.as_ref().map(|p| p.group.clone()))
        {
            props.insert("project.groupId".into(), g);
        }
        if let Some(a) = &me.artifact {
            props.insert("project.artifactId".into(), a.clone());
        }
        props
    }
}

/// Expands `${name}` references. Returns the unresolved property name on failure.
pub fn interpolate(value: &str, props: &HashMap<String, String>) -> Result<String, String> {
    let mut current = value.to_string();
    for _ in 0..8 {
        let Some(start) = current.find("${") else {
            return Ok(current);
        };
        let Some(len) = current[start..].find('}') else {
            return Err(current[start..].to_string());
        };
        let name = &current[start + 2..start + len];
        match props.get(name) {
            Some(v) => {
                current = format!("{}{}{}", &current[..start], v, &current[start + len + 1..]);
            }
            None => return Err(name.to_string()),
        }
    }
    Err(value.to_string())
}

fn is_range(version: &str) -> bool {
    version.starts_with('[') || version.starts_with('(')
}

fn version_info(
    decl: &DepDecl,
    props: &HashMap<String, String>,
    managed: &HashMap<String, (String, String)>,
    external_managers: &[String],
) -> VersionInfo {
    match &decl.version {
        Some(raw) => match interpolate(raw, props) {
            Ok(v) if is_range(&v) => VersionInfo {
                state: VersionState::Range,
                declared: Some(raw.clone()),
                resolved: None,
                note: Some(
                    "Maven version range; the selected version is decided at build time".into(),
                ),
            },
            Ok(v) => VersionInfo {
                state: VersionState::Resolved,
                declared: Some(raw.clone()),
                note: (raw != &v).then(|| format!("resolved from {raw}")),
                resolved: Some(v),
            },
            Err(missing) => VersionInfo {
                state: VersionState::Unresolved,
                declared: Some(raw.clone()),
                resolved: None,
                note: Some(format!(
                    "property `{missing}` is not defined in this repository's POMs"
                )),
            },
        },
        None => {
            if let Some((v, from)) = managed.get(&decl.coordinate()) {
                match interpolate(v, props) {
                    Ok(resolved) => VersionInfo {
                        state: VersionState::Resolved,
                        declared: None,
                        resolved: Some(resolved),
                        note: Some(format!("managed in {from}")),
                    },
                    Err(missing) => VersionInfo {
                        state: VersionState::Unresolved,
                        declared: None,
                        resolved: None,
                        note: Some(format!(
                            "managed in {from}, but property `{missing}` is undefined"
                        )),
                    },
                }
            } else if !external_managers.is_empty() {
                VersionInfo {
                    state: VersionState::Managed,
                    declared: None,
                    resolved: None,
                    note: Some(format!(
                        "version managed by {}",
                        external_managers.join(", ")
                    )),
                }
            } else {
                VersionInfo {
                    state: VersionState::Unresolved,
                    declared: None,
                    resolved: None,
                    note: Some(
                        "no version declared and no local dependencyManagement entry".into(),
                    ),
                }
            }
        }
    }
}

fn scope_label(decl: &DepDecl, base: &str) -> Option<String> {
    let scope = decl.scope.clone().unwrap_or_else(|| base.to_string());
    Some(match &decl.profile {
        Some(p) => format!("{scope} (profile {p})"),
        None => scope,
    })
}

/// Turns parsed POMs into facts and coverage.
pub fn collect(poms: &[Pom], out: &mut Collector) {
    let resolver = Resolver::new(poms);
    for (index, pom) in poms.iter().enumerate() {
        let (chain, external) = resolver.chain(index);
        let props = resolver.properties(&chain);
        let mut notes = Vec::new();
        let mut status = CoverageStatus::Complete;

        // Managed versions from local dependencyManagement, nearest wins.
        let mut managed: HashMap<String, (String, String)> = HashMap::new();
        let mut external_managers = Vec::new();
        for &i in chain.iter().rev() {
            for m in &poms[i].managed {
                if m.scope.as_deref() == Some("import") {
                    external_managers.push(format!("imported BOM {}", m.coordinate()));
                    continue;
                }
                if let Some(v) = &m.version {
                    managed.insert(m.coordinate(), (v.clone(), poms[i].path.clone()));
                }
            }
        }

        if let Some((coordinate, version)) = &external {
            let label = match version {
                Some(v) => format!(
                    "{coordinate}:{}",
                    interpolate(v, &props).unwrap_or(v.clone())
                ),
                None => coordinate.clone(),
            };
            external_managers.insert(0, label.clone());
            if !VERSION_ONLY_PARENTS.contains(&coordinate.as_str()) {
                status = CoverageStatus::Partial;
                notes.push(format!(
                    "Parent POM {label} is not in this repository; dependencies it declares are not visible."
                ));
            }
            // Record the parent as a fact so conditions can match it directly.
            // It is declared by the last POM of the local chain: this POM, or
            // a local ancestor (then the fact is inherited from there).
            let declaring = chain.last().map(|&i| &poms[i]).unwrap_or(pom);
            let origin = if std::ptr::eq(declaring, pom) {
                FactOrigin::Direct
            } else {
                FactOrigin::Inherited
            };
            if let Some(parent_decl) = declaring.parent.as_ref() {
                out.dependency(
                    &pom.module,
                    Ecosystem::Maven,
                    coordinate,
                    Some("parent".into()),
                    VersionInfo {
                        state: if version.is_some() {
                            VersionState::Resolved
                        } else {
                            VersionState::Unresolved
                        },
                        declared: version.clone(),
                        resolved: version.as_ref().and_then(|v| interpolate(v, &props).ok()),
                        note: None,
                    },
                    origin,
                    DETECTOR,
                    Evidence {
                        file: declaring.path.clone(),
                        line: Some(parent_decl.line),
                        excerpt: Some(format!("<parent> {coordinate}")),
                    },
                );
            }
        }
        if external_managers
            .iter()
            .any(|m| m.starts_with("imported BOM"))
        {
            notes.push(
                "Imported BOMs manage some versions; those versions are not resolved without Maven."
                    .into(),
            );
        }

        // Own and inherited dependencies. Inherited ones come from local
        // parents' <dependencies> (not dependencyManagement).
        for (depth, &i) in chain.iter().enumerate() {
            let source = &poms[i];
            let origin = if depth == 0 {
                FactOrigin::Direct
            } else {
                FactOrigin::Inherited
            };
            for decl in &source.dependencies {
                out.dependency(
                    &pom.module,
                    Ecosystem::Maven,
                    &decl.coordinate(),
                    scope_label(decl, "compile"),
                    version_info(decl, &props, &managed, &external_managers),
                    origin,
                    DETECTOR,
                    Evidence {
                        file: source.path.clone(),
                        line: Some(decl.line),
                        excerpt: Some(decl.coordinate()),
                    },
                );
            }
            for decl in &source.plugins {
                out.dependency(
                    &pom.module,
                    Ecosystem::Maven,
                    &decl.coordinate(),
                    scope_label(decl, "plugin"),
                    version_info(decl, &props, &HashMap::new(), &external_managers),
                    origin,
                    DETECTOR,
                    Evidence {
                        file: source.path.clone(),
                        line: Some(decl.line),
                        excerpt: Some(format!("plugin {}", decl.coordinate())),
                    },
                );
            }
        }

        out.coverage(&pom.module, "maven", status, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pom(path: &str, module: &str, xml: &str) -> Pom {
        parse(path, module, xml).unwrap()
    }

    #[test]
    fn resolves_properties_and_local_parents() {
        let parent = pom(
            "pom.xml",
            ".",
            r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
                <groupId>com.example</groupId><artifactId>root</artifactId><version>1.0</version>
                <properties><liquibase.version>4.29.1</liquibase.version></properties>
                <modules><module>api</module></modules>
                <dependencyManagement><dependencies>
                  <dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId><version>${liquibase.version}</version></dependency>
                </dependencies></dependencyManagement>
                <dependencies>
                  <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency>
                </dependencies>
              </project>"#,
        );
        let child = pom(
            "api/pom.xml",
            "api",
            r#"<project>
                <parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0</version></parent>
                <artifactId>api</artifactId>
                <dependencies>
                  <dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId></dependency>
                  <dependency><groupId>org.jooq</groupId><artifactId>jooq</artifactId><version>${jooq.version}</version></dependency>
                </dependencies>
              </project>"#,
        );
        let mut out = Collector::default();
        collect(&[parent, child], &mut out);
        let liquibase = out
            .find_dependency("api", "org.liquibase:liquibase-core")
            .unwrap();
        assert_eq!(liquibase.state, VersionState::Resolved);
        assert_eq!(liquibase.resolved.as_deref(), Some("4.29.1"));
        let jooq = out.find_dependency("api", "org.jooq:jooq").unwrap();
        assert_eq!(jooq.state, VersionState::Unresolved);
        assert!(jooq.note.as_ref().unwrap().contains("jooq.version"));
        // Inherited from the local parent's <dependencies>.
        assert!(out.find_dependency("api", "org.slf4j:slf4j-api").is_some());
        assert_eq!(
            out.coverage_status("api", "maven"),
            Some(CoverageStatus::Complete)
        );
    }

    #[test]
    fn external_parent_makes_coverage_partial_unless_version_only() {
        let boot = pom(
            "pom.xml",
            ".",
            r#"<project><parent><groupId>org.springframework.boot</groupId>
               <artifactId>spring-boot-starter-parent</artifactId><version>3.3.2</version><relativePath/></parent>
               <artifactId>svc</artifactId>
               <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
               </project>"#,
        );
        let mut out = Collector::default();
        collect(&[boot], &mut out);
        assert_eq!(
            out.coverage_status(".", "maven"),
            Some(CoverageStatus::Complete)
        );
        let web = out
            .find_dependency(".", "org.springframework.boot:spring-boot-starter-web")
            .unwrap();
        assert_eq!(web.state, VersionState::Managed);

        let corp = pom(
            "pom.xml",
            ".",
            r#"<project><parent><groupId>com.acme</groupId><artifactId>corp-parent</artifactId><version>7</version></parent>
               <artifactId>svc</artifactId></project>"#,
        );
        let mut out = Collector::default();
        collect(&[corp], &mut out);
        assert_eq!(
            out.coverage_status(".", "maven"),
            Some(CoverageStatus::Partial)
        );
    }

    #[test]
    fn external_grandparent_is_inherited_from_where_it_is_declared() {
        let root = pom(
            "pom.xml",
            ".",
            r#"<project>
               <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.2</version></parent>
               <groupId>com.example</groupId><artifactId>root</artifactId><version>1.0</version>
               </project>"#,
        );
        let child = pom(
            "api/pom.xml",
            "api",
            r#"<project>

               <parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0</version></parent>
               <artifactId>api</artifactId></project>"#,
        );
        let mut out = Collector::default();
        collect(&[root, child], &mut out);
        let fact = out
            .facts
            .iter()
            .find(|f| {
                f.module == "api"
                    && f.id
                        .ends_with("org.springframework.boot:spring-boot-starter-parent")
            })
            .expect("grandparent fact");
        assert_eq!(fact.origin, FactOrigin::Inherited);
        assert_eq!(fact.evidence[0].file, "pom.xml");
        assert_eq!(fact.evidence[0].line, Some(2));
    }

    #[test]
    fn rejects_dtds_and_reports_parse_errors() {
        let xml =
            r#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><project>&lol;</project>"#;
        assert!(parse("pom.xml", ".", xml).is_err());
        assert!(parse("pom.xml", ".", "<project><unclosed></project>").is_err());
    }

    #[test]
    fn interpolation_is_bounded() {
        let mut props = HashMap::new();
        props.insert("a".to_string(), "${b}".to_string());
        props.insert("b".to_string(), "${a}".to_string());
        assert!(interpolate("${a}", &props).is_err());
    }
}
