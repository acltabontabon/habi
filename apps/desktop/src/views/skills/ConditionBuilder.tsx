/**
 * When Habi should suggest a skill, as sentences — backed by the same
 * `habi.yaml` conditions the matcher evaluates. Each saved condition reads
 * as a statement; adding one opens only what that statement needs. Authors
 * never write YAML here; rules the builder cannot express are kept as written
 * and edited in the YAML view.
 *
 * Required tools are said apart from the conditions: they never change
 * whether Habi suggests a skill, only whether it is ready to use.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { ConditionSuggestion } from "../../bindings/ConditionSuggestion";
import type { ShareForm } from "../../bindings/ShareForm";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { type ConditionKind, conditionPhrase, type Phrase, toolPhrase } from "../../lib/applicability";
import { TAG_LABELS, tagFromInput } from "../../lib/tags";

const kindLabel: Record<ConditionKind, string> = {
  tag: "Technology",
  dependency: "Dependency",
  file: "Files",
};

const kindPlaceholder: Record<ConditionKind, string> = {
  tag: "Spring Boot, TypeScript, Liquibase…",
  dependency: "org.liquibase:liquibase-core or a package name",
  file: "**/db/changelog/**",
};

type Row = { kind: ConditionKind; value: string };

export function PhraseText({ phrase }: { phrase: Phrase }) {
  return (
    <>
      {phrase.text}
      {phrase.code ? (
        <>
          {" "}
          <code>{phrase.code}</code>
        </>
      ) : null}
      {phrase.after ? <span className="rb-after"> {phrase.after}</span> : null}
    </>
  );
}

function words(p: Phrase) {
  return [p.text, p.code, p.after].filter(Boolean).join(" ");
}

function Adder({
  kinds,
  label,
  onAdd,
  onClose,
}: {
  kinds: ConditionKind[];
  label: string;
  onAdd: (row: Row) => string | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ConditionKind>(kinds[0] ?? "tag");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
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
    <div className="rb-adder">
      <div className="rb-adder-row">
        <label className="visually-hidden" htmlFor={`${id}-kind`}>
          {label}: kind
        </label>
        <select
          id={`${id}-kind`}
          className="input rb-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ConditionKind);
            setProblem(null);
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${id}-value`}>
          {label}
        </label>
        <input
          ref={input}
          id={`${id}-value`}
          className={`input${kind === "tag" ? "" : " mono"}`}
          value={text}
          list={kind === "tag" ? `${id}-known` : undefined}
          placeholder={kindPlaceholder[kind]}
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <datalist id={`${id}-known`}>
          {Object.values(TAG_LABELS).map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <Button size="sm" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
        <Button size="sm" variant="quiet" onClick={onClose}>
          Done
        </Button>
      </div>
      {problem ? (
        <p id={`${id}-problem`} className="field-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function Statements({ rows }: { rows: { key: string; phrase: Phrase; remove: () => void }[] }) {
  return (
    <ul className="rb-rows">
      {rows.map((row) => (
        <li key={row.key} className="rb-row">
          <span className="rb-knot" aria-hidden="true" />
          <span className="rb-text">
            <PhraseText phrase={row.phrase} />
          </span>
          <button
            type="button"
            className="rb-remove"
            aria-label={`Remove: ${words(row.phrase)}`}
            onClick={row.remove}
          >
            <Icon name="close" size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Suggestions({
  projectName,
  suggestions,
  pending,
  failed,
  onAdd,
}: {
  projectName: string;
  suggestions: ConditionSuggestion[];
  pending: boolean;
  failed: boolean;
  onAdd: (row: Row) => void;
}) {
  const [all, setAll] = useState(false);
  if (pending) return <p className="rb-note">Reading {projectName}…</p>;
  if (failed) return <p className="field-problem">Habi could not inspect {projectName}.</p>;
  if (suggestions.length === 0) return null;
  const tags = suggestions.filter((s) => s.kind === "tag");
  const deps = suggestions.filter((s) => s.kind === "dependency");
  const shown = [...tags, ...(all ? deps : deps.slice(0, 6))];
  return (
    <div className="rb-suggest">
      <p className="rb-note">
        Seen in {projectName} — observed facts, not requirements. Add only what the skill depends on.
      </p>
      <div className="suggestions">
        {shown.map((s) => (
          <button
            key={`${s.kind}:${s.value}`}
            type="button"
            className="chip"
            aria-label={`Add ${s.label}${s.evidence ? `, seen in ${s.evidence}` : ""}`}
            onClick={() => onAdd({ kind: s.kind, value: s.value })}
          >
            <Icon name="plus" size={12} />
            <span className={s.kind === "dependency" ? "mono" : undefined}>{s.label}</span>
          </button>
        ))}
        {deps.length > 6 && !all ? (
          <button type="button" className="link-btn" onClick={() => setAll(true)}>
            {deps.length - 6} more dependencies
          </button>
        ) : null}
      </div>
    </div>
  );
}

const without = (list: string[], value: string) => list.filter((v) => v !== value);

export function ConditionBuilder({
  form,
  onChange,
  suggestFrom,
}: {
  form: ShareForm;
  onChange: (form: ShareForm) => void;
  /** A project whose observed facts can be offered as conditions. */
  suggestFrom?: { id: string; name: string } | null;
}) {
  const [adding, setAdding] = useState<"applies" | "excludes" | "tool" | null>(null);
  const [toolName, setToolName] = useState("");
  const [toolCommands, setToolCommands] = useState("");
  const suggestions = useQuery({
    queryKey: ["suggestions", suggestFrom?.id],
    queryFn: () => api.suggestConditions(suggestFrom?.id ?? ""),
    enabled: Boolean(suggestFrom) && adding === "applies",
    staleTime: 60_000,
  });

  const applies: Row[] = [
    ...form.appliesTags.map((value): Row => ({ kind: "tag", value })),
    ...form.appliesDependencies.map((value): Row => ({ kind: "dependency", value })),
    ...form.appliesFiles.map((value): Row => ({ kind: "file", value })),
  ];
  const excludes: Row[] = [
    ...form.excludeTags.map((value): Row => ({ kind: "tag", value })),
    ...form.excludeDependencies.map((value): Row => ({ kind: "dependency", value })),
  ];

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
      return "That exception is already listed.";
    if (row.kind === "tag") onChange({ ...form, excludeTags: [...form.excludeTags, row.value] });
    else onChange({ ...form, excludeDependencies: [...form.excludeDependencies, row.value] });
    return null;
  };
  const removeExclude = (row: Row) => {
    if (row.kind === "tag") onChange({ ...form, excludeTags: without(form.excludeTags, row.value) });
    else onChange({ ...form, excludeDependencies: without(form.excludeDependencies, row.value) });
  };
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

  const used = (s: ConditionSuggestion) =>
    s.kind === "tag" ? form.appliesTags.includes(s.value) : form.appliesDependencies.includes(s.value);

  const toggle = (which: "applies" | "excludes" | "tool") => setAdding((a) => (a === which ? null : which));

  return (
    <div className="rulebook">
      <section className="rb-section" aria-labelledby="rb-when">
        <h3 id="rb-when" className="rb-lead">
          Suggest this skill when
          {applies.length > 1 ? (
            <>
              {" "}
              <span className="rb-choice">
                {(["all", "any"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={form.matchMode === mode}
                    className={form.matchMode === mode ? "is-on" : undefined}
                    onClick={() => onChange({ ...form, matchMode: mode })}
                  >
                    {mode}
                  </button>
                ))}
              </span>{" "}
              of these hold
            </>
          ) : null}
        </h3>
        {applies.length === 0 ? (
          <p className="rb-empty">
            Nothing yet — Habi won't suggest it on its own. It's always available to use by hand.
          </p>
        ) : (
          <Statements
            rows={applies.map((r) => ({
              key: `${r.kind}:${r.value}`,
              phrase: conditionPhrase(r.kind, r.value),
              remove: () => removeApplies(r),
            }))}
          />
        )}
        {adding === "applies" ? (
          <>
            <Adder
              kinds={["tag", "dependency", "file"]}
              label="Add a condition"
              onAdd={addApplies}
              onClose={() => setAdding(null)}
            />
            {suggestFrom ? (
              <Suggestions
                projectName={suggestFrom.name}
                suggestions={(suggestions.data ?? []).filter((s) => !used(s))}
                pending={suggestions.isPending}
                failed={suggestions.isError}
                onAdd={(row) => void addApplies(row)}
              />
            ) : null}
          </>
        ) : (
          <button type="button" className="rb-add" onClick={() => toggle("applies")}>
            <Icon name="plus" size={13} /> Add a condition
          </button>
        )}
      </section>

      <section className="rb-section" aria-labelledby="rb-unless">
        <h3 id="rb-unless" className="rb-lead">
          Unless
        </h3>
        {excludes.length > 0 ? (
          <Statements
            rows={excludes.map((r) => ({
              key: `${r.kind}:${r.value}`,
              phrase: conditionPhrase(r.kind, r.value),
              remove: () => removeExclude(r),
            }))}
          />
        ) : adding !== "excludes" ? (
          <p className="rb-empty">No exceptions.</p>
        ) : null}
        {adding === "excludes" ? (
          <Adder
            kinds={["tag", "dependency"]}
            label="Add an exception"
            onAdd={addExclude}
            onClose={() => setAdding(null)}
          />
        ) : (
          <button type="button" className="rb-add" onClick={() => toggle("excludes")}>
            <Icon name="plus" size={13} /> Add an exception
          </button>
        )}
      </section>

      <section className="rb-section" aria-labelledby="rb-needs">
        <h3 id="rb-needs" className="rb-lead">
          It needs
        </h3>
        {form.tools.length > 0 ? (
          <Statements
            rows={form.tools.map((tool, index) => ({
              key: `${tool.name}-${tool.commands.join(",")}`,
              phrase: toolPhrase(tool),
              remove: () => onChange({ ...form, tools: form.tools.filter((_, i) => i !== index) }),
            }))}
          />
        ) : adding !== "tool" ? (
          <p className="rb-empty">No tools.</p>
        ) : null}
        {adding === "tool" ? (
          <div className="rb-adder">
            <div className="rb-adder-row">
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
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setAdding(null);
                  }
                }}
              />
              <Button size="sm" onClick={addTool} disabled={!toolCommands.trim()}>
                Add
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setAdding(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="rb-add" onClick={() => toggle("tool")}>
            <Icon name="plus" size={13} /> Add a required tool
          </button>
        )}
        <p className="rb-note">
          Required tools never change whether Habi suggests it; they are looked up on PATH or in the project,
          never run.
        </p>
      </section>

      {applies.length > 0 ? (
        <section className="rb-section" aria-labelledby="rb-scope">
          <h3 id="rb-scope" className="rb-lead">
            Checked across{" "}
            <span className="rb-choice">
              <button
                type="button"
                aria-pressed={!form.repositoryScope}
                className={!form.repositoryScope ? "is-on" : undefined}
                onClick={() => onChange({ ...form, repositoryScope: false })}
              >
                each module
              </button>
              <button
                type="button"
                aria-pressed={form.repositoryScope}
                className={form.repositoryScope ? "is-on" : undefined}
                onClick={() => onChange({ ...form, repositoryScope: true })}
              >
                the whole repository
              </button>
            </span>
          </h3>
          <p className="rb-note">
            {form.repositoryScope
              ? "The conditions are checked once, against everything in the repository."
              : "Each module is checked on its own; a monorepo gets the skill where it fits."}
          </p>
        </section>
      ) : null}
    </div>
  );
}
