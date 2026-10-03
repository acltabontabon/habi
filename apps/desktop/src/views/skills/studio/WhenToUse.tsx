/**
 * When Habi should suggest the skill, said as facts about a project:
 * "Playwright is used", "Depends on @playwright/test". Adding one starts from
 * a few words — Habi proposes what it could look for (a technology it
 * detects, a dependency, a file), and what it actually saw in a project — and
 * the author picks. Underneath it is the same deterministic habi.yaml the
 * matcher evaluates; the YAML is one link away for those who want it, and
 * rules these sentences cannot express are read out and kept as written.
 *
 * Without signals a skill is still complete: it is used by hand.
 */
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Condition } from "../../../bindings/Condition";
import type { ProjectRecord } from "../../../bindings/ProjectRecord";
import type { ShareForm } from "../../../bindings/ShareForm";
import type { SkillPreview } from "../../../bindings/SkillPreview";
import { Icon } from "../../../components/Icon";
import { SourceEditor } from "../../../components/lazy";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import {
  type ClauseNode,
  type ConditionKind,
  statementsFromCondition,
  toolPhrase,
} from "../../../lib/applicability";
import {
  type Proposal,
  proposeSignals,
  type Signal,
  signalClause,
  signalWords,
  technologiesIn,
} from "../../../lib/materials";
import { TAG_LABELS } from "../../../lib/tags";
import type { SkillDraft } from "./useSkillDraft";

function Words({ s }: { s: Signal }) {
  const w = signalWords(s);
  return (
    <>
      {w.text}
      {w.code ? (
        <>
          {" "}
          <code>{w.code}</code>
        </>
      ) : null}
    </>
  );
}

function Clause({ node }: { node: ClauseNode }) {
  if (node.op === "leaf") {
    return (
      <li className="wu-row">
        <span className="wu-knot" aria-hidden="true" />
        <span className="wu-text">
          {node.phrase.text}
          {node.phrase.code ? (
            <>
              {" "}
              <code>{node.phrase.code}</code>
            </>
          ) : null}
          {node.phrase.after ? <span className="wu-after"> {node.phrase.after}</span> : null}
        </span>
      </li>
    );
  }
  const items = node.op === "not" ? [node.item] : node.items;
  return (
    <li className="wu-group">
      <span className="wu-group-label">{node.label}</span>
      <ul className="wu-rows">
        {items.map((child, i) => (
          <Clause key={i} node={child} />
        ))}
      </ul>
    </li>
  );
}

/** Conditions as Habi reads them, whatever their shape. */
export function ReadRules({
  appliesWhen,
  excludes,
}: {
  appliesWhen: Condition | null;
  excludes: Condition | null;
}) {
  if (!appliesWhen && !excludes)
    return <p className="wu-empty">No signals — Habi won’t suggest it on its own.</p>;
  return (
    <div className="wu-read">
      {appliesWhen ? (
        <section className="wu-section">
          <h3 className="wu-lead">Suggest when</h3>
          <ul className="wu-rows">
            <Clause node={statementsFromCondition(appliesWhen)} />
          </ul>
        </section>
      ) : null}
      {excludes ? (
        <section className="wu-section">
          <h3 className="wu-lead">Avoid when</h3>
          <ul className="wu-rows">
            <Clause node={statementsFromCondition(excludes)} />
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type Offer = Proposal & { seen?: string };

function Adder({
  kinds,
  placeholder,
  observedFrom,
  observed,
  observing,
  onAdd,
  onClose,
}: {
  kinds: ConditionKind[];
  placeholder: string;
  observedFrom: string | null;
  observed: Offer[];
  observing: boolean;
  onAdd: (s: Signal) => string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => input.current?.focus(), []);
  const q = text.trim().toLowerCase();
  const offers: Offer[] = useMemo(() => {
    const proposed = proposeSignals(text).filter((p) => kinds.includes(p.kind));
    const seen = observed.filter(
      (o) =>
        kinds.includes(o.kind) &&
        (!q || o.value.toLowerCase().includes(q) || (TAG_LABELS[o.value] ?? "").toLowerCase().includes(q)),
    );
    const all = [...seen.slice(0, q ? 4 : 6), ...proposed];
    return all.filter((o, i) => all.findIndex((x) => x.kind === o.kind && x.value === o.value) === i);
  }, [text, q, observed, kinds]);
  const pick = (o: Offer | undefined) => {
    if (!o) return;
    const refused = onAdd(o);
    if (refused) return setProblem(refused);
    setProblem(null);
    setText("");
    setAt(0);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((a) => Math.min(a + 1, offers.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(offers[at]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="wu-adder">
      <label className="visually-hidden" htmlFor={`${id}-q`}>
        What should Habi look for?
      </label>
      <div className="wu-adder-row">
        <input
          ref={input}
          id={`${id}-q`}
          className="wu-adder-input"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={offers.length > 0}
          aria-controls={`${id}-offers`}
          aria-activedescendant={offers[at] ? `${id}-o${at}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
            setProblem(null);
          }}
          onKeyDown={onKey}
        />
        <button type="button" className="link-quiet" onClick={onClose}>
          Done
        </button>
      </div>
      {problem ? (
        <p className="field-problem" role="alert">
          {problem}
        </p>
      ) : null}
      {offers.length > 0 ? (
        <div className="wu-offers" id={`${id}-offers`} role="listbox" aria-label="Signals Habi can look for">
          {offers.map((o, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field above moves through the list.
            <div
              key={`${o.kind}:${o.value}`}
              id={`${id}-o${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              className={i === at ? "is-at" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(o)}
            >
              <span className="wu-knot" aria-hidden="true" />
              <span className="wu-text">
                <Words s={o} />
              </span>
              <span className="wu-why">{o.seen ? `seen in ${o.seen}` : o.why}</span>
            </div>
          ))}
        </div>
      ) : q ? null : observing ? (
        <p className="wu-note">Reading {observedFrom}…</p>
      ) : null}
    </div>
  );
}

function Rows({
  signals,
  onRemove,
  disabled,
}: {
  signals: Signal[];
  onRemove: (s: Signal) => void;
  disabled: boolean;
}) {
  return (
    <ul className="wu-rows">
      {signals.map((s) => (
        <li key={`${s.kind}:${s.value}`} className="wu-row">
          <span className="wu-knot" aria-hidden="true" />
          <span className="wu-text">
            <Words s={s} />
          </span>
          {disabled ? null : (
            <button
              type="button"
              className="wu-remove"
              aria-label={`Remove: ${signalWords(s).text} ${signalWords(s).code ?? ""}`.trim()}
              onClick={() => onRemove(s)}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const without = (list: string[], value: string) => list.filter((v) => v !== value);

function signalsOf(form: ShareForm) {
  const applies: Signal[] = [
    ...form.appliesTags.map((value): Signal => ({ kind: "tag", value })),
    ...form.appliesDependencies.map((value): Signal => ({ kind: "dependency", value })),
    ...form.appliesFiles.map((value): Signal => ({ kind: "file", value })),
  ];
  const excludes: Signal[] = [
    ...form.excludeTags.map((value): Signal => ({ kind: "tag", value })),
    ...form.excludeDependencies.map((value): Signal => ({ kind: "dependency", value })),
  ];
  return { applies, excludes };
}

export function addSignal(form: ShareForm, s: Signal): ShareForm {
  if (s.kind === "tag") return { ...form, appliesTags: [...form.appliesTags, s.value] };
  if (s.kind === "dependency")
    return { ...form, appliesDependencies: [...form.appliesDependencies, s.value] };
  return { ...form, appliesFiles: [...form.appliesFiles, s.value] };
}

/** A signal the instructions suggest, when there are none yet. */
export function inferredSignal(draft: SkillDraft): Signal | null {
  const { form, document, skill } = draft;
  if (!form.conditionsEditable || skill.metadataStatus === "invalid") return null;
  if (signalsOf(form).applies.length > 0) return null;
  const tag = technologiesIn(document.body)[0];
  return tag ? { kind: "tag", value: tag } : null;
}

/** "Playwright is used · 2 signals" — the rules in a line, for the head of the skill. */
export function whenLine(draft: SkillDraft): string | null {
  const { form, skill } = draft;
  if (skill.metadataStatus === "invalid") return "Needs attention";
  if (!form.conditionsEditable) return skill.summary.hasApplicability ? "Written as YAML" : null;
  const { applies } = signalsOf(form);
  if (applies.length === 0) return null;
  const first = signalWords(applies[0] as Signal);
  const lead = first.code ? `${first.text} ${first.code}` : first.text;
  return applies.length === 1
    ? lead
    : `${lead} ${form.matchMode === "all" ? "and" : "or"} ${applies.length - 1} more`;
}

export function WhenToUse({
  draft,
  projects,
  projectId,
  onProject,
  onTest,
  onOpenProject,
  preview,
}: {
  draft: SkillDraft;
  projects: ProjectRecord[];
  projectId: string | null;
  onProject: (id: string) => void;
  onTest: () => void;
  onOpenProject: () => void;
  /** The latest evaluation of the rules on screen, for the YAML view's reading. */
  preview: SkillPreview | null;
}) {
  const { form, setForm, yaml, setYaml, yamlMode, switchYaml, trashed, skill } = draft;
  const [adding, setAdding] = useState<"applies" | "excludes" | "tool" | null>(null);
  const [toolName, setToolName] = useState("");
  const [toolCommands, setToolCommands] = useState("");
  const project = projects.find((p) => p.id === projectId) ?? null;
  const suggestions = useQuery({
    queryKey: ["suggestions", projectId],
    queryFn: () => api.suggestConditions(projectId ?? ""),
    enabled: Boolean(projectId) && (adding === "applies" || adding === "excludes"),
    staleTime: 60_000,
  });
  const { applies, excludes } = signalsOf(form);
  const inferred = inferredSignal(draft);
  const observed: Offer[] = (suggestions.data ?? [])
    .filter((s) => !applies.some((a) => a.kind === s.kind && a.value === s.value))
    .map((s) => ({ kind: s.kind, value: s.value, why: s.evidence ?? "", seen: project?.name }));

  const add = (s: Signal): string | null => {
    if (applies.some((r) => r.kind === s.kind && r.value === s.value)) return "Habi already looks for that.";
    if (applies.length >= 20) return "That is a lot of signals. Remove one first, or edit the YAML.";
    setForm(addSignal(form, s));
    return null;
  };
  const remove = (s: Signal) => {
    if (s.kind === "tag") setForm({ ...form, appliesTags: without(form.appliesTags, s.value) });
    else if (s.kind === "dependency")
      setForm({ ...form, appliesDependencies: without(form.appliesDependencies, s.value) });
    else setForm({ ...form, appliesFiles: without(form.appliesFiles, s.value) });
  };
  const addExclude = (s: Signal): string | null => {
    if (excludes.some((r) => r.kind === s.kind && r.value === s.value))
      return "That exception is already listed.";
    if (s.kind === "tag") setForm({ ...form, excludeTags: [...form.excludeTags, s.value] });
    else if (s.kind === "dependency")
      setForm({ ...form, excludeDependencies: [...form.excludeDependencies, s.value] });
    else return "Exceptions are technologies or dependencies.";
    return null;
  };
  const removeExclude = (s: Signal) => {
    if (s.kind === "tag") setForm({ ...form, excludeTags: without(form.excludeTags, s.value) });
    else setForm({ ...form, excludeDependencies: without(form.excludeDependencies, s.value) });
  };
  const addTool = () => {
    const commands = toolCommands
      .split(/[,\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (commands.length === 0) return;
    setForm({
      ...form,
      tools: [...form.tools, { name: toolName.trim() || commands[0] || "Tool", commands }],
    });
    setToolName("");
    setToolCommands("");
  };

  const tryIt = (
    <section className="wu-section wu-try" aria-labelledby="wu-try">
      <h3 id="wu-try" className="wu-lead">
        Try it
      </h3>
      {projects.length === 0 ? (
        <p className="wu-line">
          <span className="wu-empty">No project open to try it against.</span>
          <button type="button" className="link-btn" onClick={onOpenProject}>
            Open a project…
          </button>
        </p>
      ) : (
        <p className="wu-line">
          <label className="visually-hidden" htmlFor="wu-project">
            Project to try it against
          </label>
          <select
            id="wu-project"
            className="wu-select"
            value={projectId ?? ""}
            onChange={(e) => onProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={onTest}>
            Test
          </Button>
        </p>
      )}
    </section>
  );

  const header = (
    <header className="wu-head">
      <h2 className="layer-title">When to use</h2>
      <p className="layer-lede">
        Habi suggests this skill in projects that show these signals. Without any, you choose it by hand.
      </p>
    </header>
  );

  if (yamlMode) {
    return (
      <div className="wu">
        {header}
        <div className="wu-yaml">
          <SourceEditor
            language="yaml"
            label="habi.yaml"
            value={yaml}
            readOnly={trashed}
            placeholder={"habi: 1\napplies_when:\n  tag: test:playwright"}
            onChange={setYaml}
          />
        </div>
        {preview?.problem ? (
          <p className="field-problem" role="alert">
            Habi can’t read this yet: {preview.problem}. It is ignored for suggestions until fixed.
          </p>
        ) : preview ? (
          <div className="wu-reads">
            <p className="wu-kicker">Habi reads this as</p>
            <ReadRules appliesWhen={preview.appliesWhen} excludes={preview.excludes} />
          </div>
        ) : null}
        {tryIt}
        <p className="wu-mode">
          <button type="button" className="link-quiet" onClick={() => void switchYaml(false)}>
            ← Back to sentences
          </button>
          <span className="wu-note">Saved as typed. Empty removes the file.</span>
        </p>
      </div>
    );
  }

  if (skill.metadataStatus === "invalid") {
    return (
      <div className="wu">
        {header}
        <p className="field-problem" role="alert">
          Habi can’t read these rules, so it ignores them for suggestions. Nothing was rewritten.
        </p>
        <ul className="wu-problems">
          {skill.diagnostics
            .filter(
              (d) => d.code === "invalidMetadata" || (d.path !== null && /(^|\/)habi\.ya?ml$/.test(d.path)),
            )
            .map((d, i) => (
              <li key={i}>{d.message}</li>
            ))}
        </ul>
        <Button size="sm" onClick={() => void switchYaml(true)}>
          Fix it in habi.yaml
        </Button>
      </div>
    );
  }

  if (!form.conditionsEditable) {
    return (
      <div className="wu">
        {header}
        <ReadRules appliesWhen={skill.appliesWhen} excludes={skill.excludes} />
        <p className="wu-note">
          Written with combinations these sentences can’t edit, so they are kept exactly as written.{" "}
          <button type="button" className="link-btn" onClick={() => void switchYaml(true)}>
            Edit as habi.yaml
          </button>
        </p>
        {tryIt}
      </div>
    );
  }

  return (
    <div className="wu">
      {header}
      <fieldset className="wu-form" disabled={trashed}>
        <legend className="visually-hidden">When Habi suggests this skill</legend>

        <section className="wu-section" aria-labelledby="wu-when">
          <h3 id="wu-when" className="wu-lead">
            Suggest when
            {applies.length > 1 ? (
              <span className="wu-choice">
                {(["any", "all"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={form.matchMode === mode}
                    className={form.matchMode === mode ? "is-on" : undefined}
                    onClick={() => setForm({ ...form, matchMode: mode })}
                  >
                    {mode === "any" ? "any of these" : "all of these"}
                  </button>
                ))}
              </span>
            ) : null}
          </h3>
          {applies.length === 0 && adding !== "applies" ? (
            inferred ? (
              <p className="wu-infer">
                <span>
                  The instructions keep mentioning <strong>{TAG_LABELS[inferred.value]}</strong>.
                </span>
                <button type="button" className="link-btn" onClick={() => add(inferred)}>
                  Suggest it when {signalClause(inferred)}
                </button>
              </p>
            ) : (
              <p className="wu-empty">Nothing yet.</p>
            )
          ) : (
            <Rows signals={applies} onRemove={remove} disabled={trashed} />
          )}
          {adding === "applies" ? (
            <Adder
              kinds={["tag", "dependency", "file"]}
              placeholder="What should Habi look for? Playwright, @playwright/test, **/db/changelog/**…"
              observedFrom={project?.name ?? null}
              observed={observed}
              observing={suggestions.isFetching}
              onAdd={add}
              onClose={() => setAdding(null)}
            />
          ) : (
            <button type="button" className="wu-add" onClick={() => setAdding("applies")}>
              <Icon name="plus" size={12} /> Add signal
            </button>
          )}
        </section>

        <section className="wu-section" aria-labelledby="wu-avoid">
          <h3 id="wu-avoid" className="wu-lead">
            Avoid when
          </h3>
          {excludes.length > 0 ? (
            <Rows signals={excludes} onRemove={removeExclude} disabled={trashed} />
          ) : adding !== "excludes" ? (
            <p className="wu-empty">Nothing yet.</p>
          ) : null}
          {adding === "excludes" ? (
            <Adder
              kinds={["tag", "dependency"]}
              placeholder="A technology or dependency that rules it out"
              observedFrom={project?.name ?? null}
              observed={observed}
              observing={suggestions.isFetching}
              onAdd={addExclude}
              onClose={() => setAdding(null)}
            />
          ) : (
            <button type="button" className="wu-add" onClick={() => setAdding("excludes")}>
              <Icon name="plus" size={12} /> Add exception
            </button>
          )}
        </section>

        {applies.length > 0 ? (
          <section className="wu-section" aria-labelledby="wu-scope">
            <h3 id="wu-scope" className="wu-lead">
              Check within
            </h3>
            <div className="wu-radios">
              {(
                [
                  [false, "each module"],
                  [true, "the whole repository"],
                ] as const
              ).map(([repo, label]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={form.repositoryScope === repo}
                  className={form.repositoryScope === repo ? "is-on" : undefined}
                  onClick={() => setForm({ ...form, repositoryScope: repo })}
                >
                  <span className="wu-radio" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="wu-section" aria-labelledby="wu-needs">
          <h3 id="wu-needs" className="wu-lead">
            Needs
          </h3>
          {form.tools.length > 0 ? (
            <ul className="wu-rows">
              {form.tools.map((tool, index) => {
                const p = toolPhrase(tool);
                return (
                  <li key={`${tool.name}-${tool.commands.join(",")}`} className="wu-row">
                    <span className="wu-knot is-tool" aria-hidden="true" />
                    <span className="wu-text">
                      {tool.name} <code>{tool.commands.join(" or ")}</code>
                      {p.after ? <span className="wu-after"> {p.after}</span> : null}
                    </span>
                    {trashed ? null : (
                      <button
                        type="button"
                        className="wu-remove"
                        aria-label={`Remove: ${tool.name}`}
                        onClick={() => setForm({ ...form, tools: form.tools.filter((_, i) => i !== index) })}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : adding !== "tool" ? (
            <p className="wu-empty">No tools. Looked up on PATH, never run.</p>
          ) : null}
          {adding === "tool" ? (
            <div className="wu-adder is-tool">
              <input
                className="wu-adder-input"
                aria-label="Tool name"
                placeholder="Name, e.g. Maven"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
              />
              <input
                className="wu-adder-input mono"
                aria-label="Commands, any one of which satisfies the requirement"
                placeholder="mvn, ./mvnw"
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
          ) : (
            <button type="button" className="wu-add" onClick={() => setAdding("tool")}>
              <Icon name="plus" size={12} /> Add tool
            </button>
          )}
        </section>
      </fieldset>

      {tryIt}

      <p className="wu-mode">
        <button type="button" className="link-quiet" onClick={() => void switchYaml(true)}>
          View as habi.yaml →
        </button>
      </p>
    </div>
  );
}
