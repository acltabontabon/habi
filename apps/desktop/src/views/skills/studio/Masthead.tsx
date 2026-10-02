/**
 * The skill's head: where it came from, what it is called, what it is for,
 * the identifier agents see, and whether it is ready — the frontmatter of
 * SKILL.md, set as the head of a document. One action leads on: Use & share.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LocalSkillSummary } from "../../../bindings/LocalSkillSummary";
import type { SkillStanding } from "../../../bindings/SkillStanding";
import { BackLink } from "../../../components/BackLink";
import { Icon } from "../../../components/Icon";
import { Menu } from "../../../components/Menu";
import { SaveIndicator } from "../../../components/SaveIndicator";
import { Button } from "../../../components/ui";
import { dyeMap } from "../../../lib/dye";
import { plural, relativeTime } from "../../../lib/format";
import { useSkills, useSources } from "../../../lib/queries";
import { identifierProblem, originText, slugify } from "../../../lib/skills";
import type { SkillDraft } from "./useSkillDraft";

const DESCRIPTION_LIMIT = 1024;

/** The copy's thread: the original's dye, the knot where it became yours, and what you added. */
export function LineageThread({
  origin,
  modified,
  newer,
}: {
  origin: LocalSkillSummary["origin"];
  modified: boolean;
  newer: boolean;
}) {
  const sources = useSources();
  const library = origin.type === "library" ? origin : null;
  const source = library ? (sources.data ?? []).find((s) => s.name === library.sourceName) : undefined;
  const dye = source ? dyeMap(sources.data ?? []).get(source.id) : undefined;
  const copied = origin.type === "library" || origin.type === "folder" || origin.type === "project";
  return (
    <svg className="lineage-thread" width="46" height="10" viewBox="0 0 46 10" aria-hidden="true">
      {copied ? (
        <line
          x1="1"
          y1="5"
          x2="17"
          y2="5"
          stroke={dye?.color ?? "var(--ink-faint)"}
          strokeWidth="2"
          strokeDasharray={dye?.community ? "3 2" : undefined}
          strokeLinecap="round"
        />
      ) : null}
      {newer ? <circle cx="9" cy="5" r="2.2" fill="var(--thread)" /> : null}
      <circle
        cx="22"
        cy="5"
        r="3.4"
        fill={copied ? "var(--paper)" : "var(--ink-soft)"}
        stroke="var(--ink-soft)"
        strokeWidth="1.5"
      />
      <line
        x1="27"
        y1="5"
        x2="45"
        y2="5"
        stroke={modified ? "var(--thread)" : "var(--hairline-strong)"}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function lineageWords(summary: LocalSkillSummary, standing: SkillStanding | undefined) {
  const o = summary.origin;
  const parts: { text: string; tone?: "thread" | "muted" }[] = [];
  switch (o.type) {
    case "created":
      parts.push({ text: "Written here" });
      break;
    case "createdForProject":
      parts.push({ text: `Written here for ${o.projectName}` });
      break;
    case "instructions":
      parts.push({ text: `Started from ${o.path.split("/").pop()} in ${o.projectName}` });
      break;
    case "folder":
      parts.push({ text: `Copied from ${o.path.split("/").filter(Boolean).pop() ?? "a folder"}` });
      break;
    case "project":
      parts.push({ text: `Copied from ${o.projectName}` });
      break;
    case "library":
      parts.push({ text: o.sourceName });
      break;
  }
  if (summary.modifiedLocally === true) parts.push({ text: "changed here", tone: "thread" });
  else if (summary.modifiedLocally === false) parts.push({ text: "as copied", tone: "muted" });
  if (standing?.upstream === "changed") parts.push({ text: "newer version available", tone: "thread" });
  if (standing?.upstream === "removed") parts.push({ text: "no longer in the library", tone: "muted" });
  return parts;
}

function AutoGrow({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grows with the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

/** The identifier is changed deliberately, never one keystroke at a time. */
function Identifier({
  draft,
  standing,
  editing,
  setEditing,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  editing: boolean;
  setEditing: (on: boolean) => void;
}) {
  const { document, setDocument, title, trashed, skill } = draft;
  const [text, setText] = useState(document.name);
  const skills = useSkills();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (editing) {
      setText(document.name);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [editing, document.name]);

  const wanted = text.trim();
  const taken = (skills.data ?? []).some(
    (s) => s.id !== skill.summary.id && s.deletedAt === null && s.name === wanted,
  );
  const problem =
    identifierProblem(wanted) ?? (taken ? "Another of your skills uses this identifier." : null);
  const suggestion = slugify(title);
  const installed = standing?.installedIn ?? [];
  const apply = () => {
    if (problem) return;
    if (wanted !== document.name) setDocument((d) => ({ ...d, name: wanted }));
    setEditing(false);
  };

  if (!editing) {
    const nameProblem = identifierProblem(document.name);
    return (
      <span className="studio-ident">
        <span className="studio-key">name</span>
        <code
          className={nameProblem ? "is-problem" : undefined}
          title={nameProblem ?? "The identifier agents see"}
        >
          {document.name || "—"}
        </code>
        {!trashed ? (
          <button
            type="button"
            className="link-quiet"
            id="studio-identifier"
            onClick={() => setEditing(true)}
          >
            {document.name ? "Change" : "Set"}
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <fieldset className="studio-ident-edit">
      <legend className="visually-hidden">Change the identifier</legend>
      <label className="studio-key" htmlFor="studio-identifier-input">
        name
      </label>
      <input
        ref={input}
        id="studio-identifier-input"
        className="input mono"
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem ? true : undefined}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
      <Button size="sm" variant="primary" disabled={Boolean(problem)} onClick={apply}>
        Apply
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      <p id={hintId} className={problem ? "field-problem" : "field-hint"}>
        {problem ??
          "Lowercase words joined by hyphens. Agents and install folders use it; the package folder does not change."}
        {suggestion && suggestion !== wanted ? (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={() => setText(suggestion)}>
              Use <span className="mono">{suggestion}</span>
            </button>
          </>
        ) : null}
      </p>
      {installed.length > 0 && wanted !== document.name ? (
        <p className="field-hint studio-ident-warn">
          <Icon name="info" size={13} />
          Installed in {installed.map((p) => p.projectName).join(", ")} as{" "}
          <span className="mono">{document.name}</span>. Those copies keep that name until you use it there
          again.
        </p>
      ) : null}
    </fieldset>
  );
}

export function Masthead({
  draft,
  standing,
  onOpen,
  onTrash,
  onReveal,
  onRestore,
  identEditing,
  setIdentEditing,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  /** Opens a panel: what it came from, or how to use and share it. */
  onOpen: (view: "lineage" | "share") => void;
  onTrash: () => void;
  onReveal: () => void;
  onRestore: () => void;
  identEditing: boolean;
  setIdentEditing: (on: boolean) => void;
}) {
  const { skill, title, setTitle, document, setDocument, trashed, broken, saveState } = draft;
  const [details, setDetails] = useState(false);
  const errors = skill.diagnostics.filter((d) => d.level === "error").length;
  const warnings = skill.diagnostics.filter((d) => d.level === "warning").length;
  const supporting = skill.files.filter((f) => f.path !== "SKILL.md" && !/^habi\.ya?ml$/.test(f.path));
  const length = document.description.length;
  const lineage = lineageWords(skill.summary, standing);
  const installed = standing?.installedIn ?? [];

  return (
    <header className="studio-head">
      <div className="studio-topline">
        <BackLink fallback={{ name: "skills" }} fallbackLabel="My skills" />
        {!trashed ? <SaveIndicator state={saveState} savedAt={skill.summary.updatedAt} /> : null}
      </div>

      <button
        type="button"
        className="studio-lineage"
        onClick={() => onOpen("lineage")}
        title={originText(skill.summary.origin)}
      >
        <LineageThread
          origin={skill.summary.origin}
          modified={skill.summary.modifiedLocally === true}
          newer={standing?.upstream === "changed"}
        />
        {lineage.map((p, i) => (
          <span key={i} className={p.tone ? `tone-${p.tone}` : undefined}>
            {p.text}
          </span>
        ))}
        <Icon name="chevronRight" size={12} />
      </button>

      <div className="studio-title-row">
        <label className="visually-hidden" htmlFor="studio-title">
          Skill title
        </label>
        <input
          id="studio-title"
          className="studio-title"
          value={title}
          placeholder="Untitled skill"
          disabled={trashed}
          spellCheck
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="studio-actions">
          {trashed ? (
            <Button variant="primary" onClick={onRestore}>
              Restore
            </Button>
          ) : (
            <>
              <Button variant="primary" icon="share" onClick={() => onOpen("share")}>
                Use &amp; share
              </Button>
              <Menu
                label="More for this skill"
                items={[
                  [
                    {
                      label: "Show the package folder",
                      icon: "folder",
                      hint: "In your file manager",
                      onSelect: onReveal,
                    },
                  ],
                  [
                    {
                      label: "Move to trash",
                      icon: "trash",
                      danger: true,
                      hint: "Restore it from My skills",
                      onSelect: onTrash,
                    },
                  ],
                ]}
              />
            </>
          )}
        </div>
      </div>

      <div className="studio-purpose">
        <label className="visually-hidden" htmlFor="studio-purpose">
          Purpose (description)
        </label>
        <AutoGrow
          id="studio-purpose"
          className="studio-lede"
          value={document.description}
          disabled={trashed || broken}
          placeholder="What it helps accomplish, and when an agent should use it."
          aria-describedby="studio-purpose-hint"
          aria-invalid={length > DESCRIPTION_LIMIT ? true : undefined}
          onChange={(description) => setDocument((d) => ({ ...d, description }))}
        />
        <p
          id="studio-purpose-hint"
          className={`studio-purpose-hint${length > DESCRIPTION_LIMIT ? " is-over" : ""}${
            document.description.trim() === "" ? " is-empty" : ""
          }`}
        >
          <span className="studio-key">description</span>
          {length > DESCRIPTION_LIMIT ? (
            <span>
              {length} characters — the format allows {DESCRIPTION_LIMIT}.
            </span>
          ) : (
            <span>
              Agents decide whether to load a skill from this text alone. Name the task and the moment to use
              it.
              {length > DESCRIPTION_LIMIT - 150 ? (
                <span className="mono"> {DESCRIPTION_LIMIT - length} left</span>
              ) : null}
            </span>
          )}
        </p>
      </div>

      <div className="studio-sig">
        <Identifier draft={draft} standing={standing} editing={identEditing} setEditing={setIdentEditing} />
        <span className="studio-sig-rest">
          {trashed ? (
            <span>In the trash since {relativeTime(skill.summary.deletedAt)}</span>
          ) : (
            <button type="button" className="studio-validity" onClick={() => onOpen("share")}>
              {errors > 0 ? (
                <span className="tone-warn">
                  <Icon name="warning" size={13} /> {plural(errors, "thing")} to finish
                </span>
              ) : (
                <span className="tone-ok">
                  <Icon name="check" size={13} /> Ready to use
                </span>
              )}
              {warnings > 0 ? <span className="muted"> · {plural(warnings, "note")}</span> : null}
            </button>
          )}
          {installed.length > 0 ? (
            <span className="muted" title={installed.map((p) => p.projectName).join(", ")}>
              in {plural(installed.length, "project")}
            </span>
          ) : null}
          <button
            type="button"
            className="sig-toggle"
            aria-expanded={details}
            aria-controls="studio-details"
            onClick={() => setDetails((d) => !d)}
          >
            Package
            <Icon name="chevronDown" size={12} />
          </button>
        </span>
      </div>
      {details ? (
        <dl className="studio-details" id="studio-details">
          <dt>Format</dt>
          <dd>
            Agent Skills package — <span className="mono">SKILL.md</span>
            {supporting.length > 0 ? ` and ${plural(supporting.length, "supporting file")}` : ""}. Works
            without Habi.
          </dd>
          <dt>Rules</dt>
          <dd>
            {skill.metadataText !== null ? (
              <>
                <span className="mono">habi.yaml</span> — read by Habi only; other tools ignore it.
              </>
            ) : (
              "None. Habi does not suggest it on its own; it is always available to use by hand."
            )}
          </dd>
          <dt>Origin</dt>
          <dd>{originText(skill.summary.origin)}</dd>
          <dt>Stored in</dt>
          <dd>
            <span className="mono studio-path" title={skill.location}>
              {skill.location}
            </span>{" "}
            <button type="button" className="link-btn" onClick={onReveal}>
              Show
            </button>
          </dd>
          <dt>Created</dt>
          <dd>
            {relativeTime(skill.summary.createdAt)} · edited {relativeTime(skill.summary.updatedAt)}
          </dd>
        </dl>
      ) : null}
    </header>
  );
}
