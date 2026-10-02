/** What Habi knows about the project, how it knows it, and what it could not establish. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Fact } from "../../bindings/Fact";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, Label, Notice, Section, Status } from "../../components/ui";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { invalidateProjectData } from "../../lib/queries";
import { EvidenceExcerpt } from "./Explain";
import { tagLabel } from "./ProjectView";

const originLabel = {
  direct: "read directly",
  derived: "derived",
  inherited: "inherited from a parent build",
  declared: "declared by you",
} as const;

function FactRow({ fact, projectId }: { fact: Fact; projectId: string }) {
  const [open, setOpen] = useState(false);
  const e = fact.evidence[0];
  const s = fact.subject;
  const title = s.type === "tag" ? tagLabel(s.tag) : s.type === "dependency" ? s.name : s.path;
  const detail =
    s.type === "dependency"
      ? `${s.ecosystem}${s.scope ? ` · ${s.scope}` : ""} · ${
          s.version.state === "resolved"
            ? (s.version.resolved ?? "resolved")
            : s.version.state === "range"
              ? `range ${s.version.declared ?? ""}`
              : s.version.state === "managed"
                ? "version managed elsewhere"
                : "version unresolved"
        }`
      : s.type === "file"
        ? s.role
        : (fact.note ?? "");
  return (
    <li className="fact">
      <div className="fact-line">
        <span className="fact-title">{title}</span>
        <span className="fact-detail muted">{detail}</span>
        {s.type === "dependency" && s.version.note ? (
          <span className="fact-note muted">{s.version.note}</span>
        ) : null}
        <span className="fact-origin">{originLabel[fact.origin]}</span>
        {e ? (
          <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="file" size={13} />
            <span className="mono">{e.line ? `${e.file}:${e.line}` : e.file}</span>
          </button>
        ) : null}
      </div>
      {open && e ? <EvidenceExcerpt projectId={projectId} file={e.file} line={e.line} /> : null}
    </li>
  );
}

export function EvidenceView({ overview }: { overview: ProjectOverview }) {
  const { inspection, project } = overview;
  const client = useQueryClient();
  const toast = useToast();
  const [exclusions, setExclusions] = useState(project.exclusions.join("\n"));
  const modules = inspection.modules;

  const saveExclusions = async () => {
    try {
      const list = exclusions
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await api.setExclusions(project.id, list);
      invalidateProjectData(client, project.id);
      toast.show("Exclusions saved. The project will be scanned again.");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    }
  };

  const retract = async (id: string) => {
    try {
      await api.retract(project.id, id);
      invalidateProjectData(client, project.id);
      toast.show("Declaration removed. Recommendations use what Habi found again.");
    } catch (e) {
      toast.show(`Could not remove the declaration: ${e instanceof Error ? e.message : String(e)}`, "danger");
    }
  };

  return (
    <div className="page evidence-page">
      <p className="lead-sm">
        Habi read {plural(inspection.scan.filesSeen, "file name")}, the build manifests and recognized files
        in {inspection.scan.elapsedMs} ms. It does not run builds, resolve remote dependencies or treat README
        text as evidence.
      </p>

      {overview.declarations.length > 0 ? (
        <Section title="Your declarations" id="declarations">
          <ul className="declarations">
            {overview.declarations.map((d) => (
              <li key={d.id}>
                <Label tone="thread">yours</Label>{" "}
                {d.subject.type === "tag" ? tagLabel(d.subject.tag) : d.subject.name}{" "}
                <strong>{d.present ? "present" : "absent"}</strong>
                <span className="muted"> · {d.module === "*" ? "whole repository" : d.module}</span>
                {d.note ? <span className="muted"> — “{d.note}”</span> : null}
                <Button size="sm" variant="quiet" onClick={() => void retract(d.id)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {modules.map((m) => {
        const facts = inspection.facts.filter((f) => f.module === m.id);
        const tags = facts.filter((f) => f.subject.type === "tag");
        const deps = facts.filter((f) => f.subject.type === "dependency");
        const files = facts.filter((f) => f.subject.type === "file");
        const gaps = inspection.coverage.filter((c) => c.module === m.id && c.status !== "complete");
        return (
          <Section
            key={m.id}
            title={m.id === "." ? `${m.name} (root)` : m.name}
            id={`module-${m.id}`}
            aside={<span className="mono muted">{m.id === "." ? "" : m.id}</span>}
          >
            <p className="muted">
              {m.ecosystems.length > 0 ? `Build: ${m.ecosystems.join(", ")}` : "No build manifest"} ·{" "}
              {plural(deps.length, "dependency", "dependencies")} · {plural(files.length, "recognized file")}
            </p>
            {gaps.map((g) => (
              <Notice
                key={g.area}
                tone={g.status === "failed" ? "danger" : "unknown"}
                title={`${g.area} evidence is ${g.status}`}
              >
                {g.notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
                <p className="muted">
                  Conditions that depend on this are reported as not established, not as false.
                </p>
              </Notice>
            ))}
            {tags.length > 0 ? (
              <div className="tag-cloud">
                {tags.map((t) => (
                  <Status key={t.id} tone="ok">
                    {t.subject.type === "tag" ? tagLabel(t.subject.tag) : ""}
                  </Status>
                ))}
              </div>
            ) : null}
            {deps.length + files.length > 0 ? (
              <details className="facts-details">
                <summary>Facts and where they come from</summary>
                <ul className="facts">
                  {[...deps, ...files].map((f) => (
                    <FactRow key={f.id} fact={f} projectId={project.id} />
                  ))}
                </ul>
              </details>
            ) : null}
          </Section>
        );
      })}

      <Section title="Scan scope" id="scope">
        <p className="muted">
          Skipped by default:{" "}
          {inspection.scan.directoriesSkipped.length > 0
            ? inspection.scan.directoriesSkipped.join(", ")
            : "nothing present"}
          . Files that may hold secrets (.env, keys) are never read. Symbolic links skipped:{" "}
          {inspection.scan.symlinksSkipped}.
        </p>
        {inspection.scan.unreadable.length > 0 ? (
          <Notice tone="warn" title="Some paths could not be read">
            <span className="mono">{inspection.scan.unreadable.slice(0, 5).join(", ")}</span>
          </Notice>
        ) : null}
        <label className="field">
          <span className="field-label">Exclude paths (one glob per line, relative to the project)</span>
          <textarea
            className="input mono"
            rows={3}
            value={exclusions}
            onChange={(e) => setExclusions(e.target.value)}
            placeholder="e.g. legacy/**"
          />
        </label>
        <Button size="sm" onClick={() => void saveExclusions()}>
          Save exclusions
        </Button>
      </Section>
    </div>
  );
}
