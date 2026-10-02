/**
 * Applicability as readable sentences, backed by the same `habi.yaml`
 * conditions the matcher evaluates. Authors never write YAML here; rules
 * the builder cannot express are kept as written and edited in the raw view.
 */
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ConditionSuggestion } from "../../bindings/ConditionSuggestion";
import type { ProjectRecord } from "../../bindings/ProjectRecord";
import type { ShareForm } from "../../bindings/ShareForm";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { TAG_LABELS, tagFromInput, tagPhrase } from "../../lib/tags";

type Kind = "tag" | "dependency" | "file";

const kindLabel: Record<Kind, string> = {
  tag: "Technology",
  dependency: "Dependency",
  file: "Files",
};

const kindPlaceholder: Record<Kind, string> = {
  tag: "Spring Boot, TypeScript, Liquibase…",
  dependency: "org.liquibase:liquibase-core or a package name",
  file: "**/db/changelog/**",
};

type Row = { kind: Kind; value: string };

function rowText(row: Row): { lead: string; value: string } {
  if (row.kind === "tag") return { lead: "", value: tagPhrase(row.value) };
  if (row.kind === "dependency") return { lead: "depends on", value: row.value };
  return { lead: "has files matching", value: row.value };
}

function Adder({
  kinds,
  label,
  onAdd,
}: {
  kinds: Kind[];
  label: string;
  onAdd: (row: Row) => string | null;
}) {
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "tag");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const listId = useId();
  const add = () => {
    const raw = text.trim();
    if (!raw) return;
    let value: string | null = raw;
    if (kind === "tag") {
      value = tagFromInput(raw);
      if (!value) {
        setProblem("Choose a technology from the list, or type a tag such as framework:spring-boot.");
        return;
      }
    }
    const refused = onAdd({ kind, value });
    if (refused) {
      setProblem(refused);
      return;
    }
    setProblem(null);
    setText("");
  };
  return (
    <div className="rule-adder">
      <div className="rule-adder-row">
        <label className="visually-hidden" htmlFor={`${listId}-kind`}>
          {label}: kind
        </label>
        <select
          id={`${listId}-kind`}
          className="input rule-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setProblem(null);
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${listId}-value`}>
          {label}
        </label>
        <input
          id={`${listId}-value`}
          className={`input${kind === "tag" ? "" : " mono"}`}
          value={text}
          list={kind === "tag" ? `${listId}-known` : undefined}
          placeholder={kindPlaceholder[kind]}
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${listId}-problem` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <datalist id={`${listId}-known`}>
          {Object.values(TAG_LABELS).map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <Button size="sm" icon="plus" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
      </div>
      {problem ? (
        <p id={`${listId}-problem`} className="field-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function Rows({ rows, onRemove, empty }: { rows: Row[]; onRemove: (row: Row) => void; empty: string }) {
  if (rows.length === 0) return <p className="rule-empty">{empty}</p>;
  return (
    <ul className="rules">
      {rows.map((row) => {
        const t = rowText(row);
        return (
          <li key={`${row.kind}:${row.value}`} className="rule">
            <span className="rule-knot" aria-hidden="true" />
            <span className="rule-text">
              {t.lead ? <span className="rule-lead">{t.lead} </span> : null}
              <span className={row.kind === "tag" ? "rule-value" : "rule-value mono"}>{t.value}</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove: ${t.lead} ${t.value}`.replace(/\s+/g, " ")}
              onClick={() => onRemove(row)}
            >
              <Icon name="close" size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function appliesRows(form: ShareForm): Row[] {
  return [
    ...form.appliesTags.map((value): Row => ({ kind: "tag", value })),
    ...form.appliesDependencies.map((value): Row => ({ kind: "dependency", value })),
    ...form.appliesFiles.map((value): Row => ({ kind: "file", value })),
  ];
}

function excludeRows(form: ShareForm): Row[] {
  return [
    ...form.excludeTags.map((value): Row => ({ kind: "tag", value })),
    ...form.excludeDependencies.map((value): Row => ({ kind: "dependency", value })),
  ];
}

const without = (list: string[], value: string) => list.filter((v) => v !== value);

export function ConditionBuilder({
  form,
  onChange,
  projects,
  defaultProjectId,
}: {
  form: ShareForm;
  onChange: (form: ShareForm) => void;
  projects: ProjectRecord[];
  defaultProjectId?: string;
}) {
  const [suggestFrom, setSuggestFrom] = useState(defaultProjectId ?? "");
  const [showAllDeps, setShowAllDeps] = useState(false);
  const [toolName, setToolName] = useState("");
  const [toolCommands, setToolCommands] = useState("");
  const suggestions = useQuery({
    queryKey: ["suggestions", suggestFrom],
    queryFn: () => api.suggestConditions(suggestFrom),
    enabled: Boolean(suggestFrom),
    staleTime: 60_000,
  });

  const applies = appliesRows(form);
  const excludes = excludeRows(form);

  const addApplies = (row: Row): string | null => {
    if (applies.some((r) => r.kind === row.kind && r.value === row.value))
      return "That condition is already listed.";
    if (applies.length >= 20) return "That is a lot of conditions. Remove one first, or use the YAML view.";
    if (row.kind === "tag") onChange({ ...form, appliesTags: [...form.appliesTags, row.value] });
    else if (row.kind === "dependency")
      onChange({ ...form, appliesDependencies: [...form.appliesDependencies, row.value] });
    else onChange({ ...form, appliesFiles: [...form.appliesFiles, row.value] });
    return null;
  };
  const removeApplies = (row: Row) => {
    if (row.kind === "tag") onChange({ ...form, appliesTags: without(form.appliesTags, row.value) });
    else if (row.kind === "dependency")
      onChange({ ...form, appliesDependencies: without(form.appliesDependencies, row.value) });
    else onChange({ ...form, appliesFiles: without(form.appliesFiles, row.value) });
  };
  const addExclude = (row: Row): string | null => {
    if (excludes.some((r) => r.kind === row.kind && r.value === row.value))
      return "That exclusion is already listed.";
    if (row.kind === "tag") onChange({ ...form, excludeTags: [...form.excludeTags, row.value] });
    else onChange({ ...form, excludeDependencies: [...form.excludeDependencies, row.value] });
    return null;
  };
  const removeExclude = (row: Row) => {
    if (row.kind === "tag") onChange({ ...form, excludeTags: without(form.excludeTags, row.value) });
    else onChange({ ...form, excludeDependencies: without(form.excludeDependencies, row.value) });
  };

  const used = (s: ConditionSuggestion) =>
    s.kind === "tag" ? form.appliesTags.includes(s.value) : form.appliesDependencies.includes(s.value);
  const offered = (suggestions.data ?? []).filter((s) => !used(s));
  const offeredTags = offered.filter((s) => s.kind === "tag");
  const offeredDeps = offered.filter((s) => s.kind === "dependency");
  const shownDeps = showAllDeps ? offeredDeps : offeredDeps.slice(0, 8);

  const addTool = () => {
    const commands = toolCommands
      .split(/[,\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (commands.length === 0) return;
    onChange({
      ...form,
      tools: [...form.tools, { name: toolName.trim() || commands[0] || "Tool", commands }],
    });
    setToolName("");
    setToolCommands("");
  };

  return (
    <div className="builder">
      <section className="builder-block" aria-labelledby="applies-title">
        <div className="builder-head">
          <h3 id="applies-title" className="builder-title">
            Applies to a project when
          </h3>
          {applies.length > 1 ? (
            <div className="segmented-control" role="radiogroup" aria-label="How conditions combine">
              {(["all", "any"] as const).map((mode) => (
                <label key={mode} className={form.matchMode === mode ? "is-on" : undefined}>
                  <input
                    type="radio"
                    name="match-mode"
                    checked={form.matchMode === mode}
                    onChange={() => onChange({ ...form, matchMode: mode })}
                  />
                  {mode === "all" ? "all of these hold" : "any one holds"}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <Rows
          rows={applies}
          onRemove={removeApplies}
          empty="No conditions yet. Without any, Habi lists this skill for manual use and never recommends it."
        />
        <Adder kinds={["tag", "dependency", "file"]} label="Add a condition" onAdd={addApplies} />

        {projects.length > 0 ? (
          <div className="suggest">
            <label className="suggest-from">
              <span>Suggest from what Habi observed in</span>
              <select
                className="input"
                value={suggestFrom}
                onChange={(e) => {
                  setSuggestFrom(e.target.value);
                  setShowAllDeps(false);
                }}
              >
                <option value="">— choose a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {suggestFrom && suggestions.isPending ? <p className="muted">Reading the project…</p> : null}
            {suggestFrom && suggestions.isError ? (
              <p className="field-problem">Habi could not inspect that project.</p>
            ) : null}
            {suggestFrom && suggestions.data ? (
              offered.length === 0 ? (
                <p className="muted">Nothing more to suggest from this project.</p>
              ) : (
                <>
                  <p className="field-hint">
                    Observed facts, not requirements. Add only what the skill really depends on.
                  </p>
                  <div className="suggestions">
                    {[...offeredTags, ...shownDeps].map((s) => (
                      <button
                        key={`${s.kind}:${s.value}`}
                        type="button"
                        className="chip"
                        aria-label={`Add ${s.label}${s.evidence ? `, seen in ${s.evidence}` : ""}`}
                        onClick={() => addApplies({ kind: s.kind, value: s.value })}
                      >
                        <Icon name="plus" size={12} />
                        <span className={s.kind === "dependency" ? "mono" : undefined}>{s.label}</span>
                        {s.evidence ? <span className="chip-evidence mono">{s.evidence}</span> : null}
                      </button>
                    ))}
                    {offeredDeps.length > shownDeps.length ? (
                      <button type="button" className="link-btn" onClick={() => setShowAllDeps(true)}>
                        {offeredDeps.length - shownDeps.length} more dependencies
                      </button>
                    ) : null}
                  </div>
                </>
              )
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="builder-block" aria-labelledby="excludes-title">
        <h3 id="excludes-title" className="builder-title">
          Never applies when
        </h3>
        <Rows rows={excludes} onRemove={removeExclude} empty="No exclusions." />
        <Adder kinds={["tag", "dependency"]} label="Add an exclusion" onAdd={addExclude} />
      </section>

      <section className="builder-block" aria-labelledby="tools-title">
        <h3 id="tools-title" className="builder-title">
          Needs these tools
        </h3>
        {form.tools.length === 0 ? (
          <p className="rule-empty">None. Add a command the agent must be able to run, if there is one.</p>
        ) : (
          <ul className="rules">
            {form.tools.map((tool, index) => (
              <li key={`${tool.name}-${tool.commands.join(",")}`} className="rule">
                <span className="rule-knot" aria-hidden="true" />
                <span className="rule-text">
                  <span className="rule-value">{tool.name}</span>
                  <span className="rule-lead"> — any of </span>
                  <span className="mono">{tool.commands.join(", ")}</span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove tool ${tool.name}`}
                  onClick={() => onChange({ ...form, tools: form.tools.filter((_, i) => i !== index) })}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="rule-adder-row">
          <input
            className="input"
            aria-label="Tool name"
            placeholder="Name, e.g. Maven"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
          />
          <input
            className="input mono"
            aria-label="Commands, any one of which satisfies the requirement"
            placeholder="./mvnw, mvn"
            value={toolCommands}
            spellCheck={false}
            onChange={(e) => setToolCommands(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTool();
              }
            }}
          />
          <Button size="sm" icon="plus" onClick={addTool} disabled={!toolCommands.trim()}>
            Add
          </Button>
        </div>
        <p className="field-hint">Looked up on PATH or in the project. Never run while matching.</p>
      </section>

      <section className="builder-block" aria-labelledby="scope-title">
        <h3 id="scope-title" className="builder-title">
          Check the conditions against
        </h3>
        <div className="segmented-control" role="radiogroup" aria-labelledby="scope-title">
          <label className={!form.repositoryScope ? "is-on" : undefined}>
            <input
              type="radio"
              name="scope"
              checked={!form.repositoryScope}
              onChange={() => onChange({ ...form, repositoryScope: false })}
            />
            each module on its own
          </label>
          <label className={form.repositoryScope ? "is-on" : undefined}>
            <input
              type="radio"
              name="scope"
              checked={form.repositoryScope}
              onChange={() => onChange({ ...form, repositoryScope: true })}
            />
            the repository as a whole
          </label>
        </div>
      </section>
    </div>
  );
}
