/**
 * My skills: the knowledge this person keeps — written here or brought in
 * and made their own — as an index rather than a wall of cards. Each row
 * says what the skill is for, its thread (where it came from, in its
 * library's dye, and whether it was changed here), and one word for where it
 * stands: Ready, or Draft and what is missing. Quiet facets narrow the list;
 * "/" searches; ↑/↓ or j/k move and Enter opens. Grouped by when it was last
 * touched, or by letter when sorted by title, so three skills and three
 * hundred both read well.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../bindings/LocalSkill";
import type { LocalSkillSummary } from "../../bindings/LocalSkillSummary";
import type { SkillStanding } from "../../bindings/SkillStanding";
import { Icon } from "../../components/Icon";
import { Menu } from "../../components/Menu";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { type Dye, dyeMap } from "../../lib/dye";
import { plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useSkills, useSkillsOverview, useSources } from "../../lib/queries";
import { purpose } from "../../lib/skills";
import { OnThisMachine } from "./OnThisMachine";
import { ShareSkillDialog } from "./ShareSkillDialog";
import { SkillsEmpty } from "./SkillsEmpty";
import { isCopy, onward, Provenance } from "./studio/Provenance";
import { UseSkillDialog } from "./UseSkillDialog";

const SkillStudio = lazy(() => import("./studio/SkillStudio").then((m) => ({ default: m.SkillStudio })));

type Facet = "all" | "mine" | "imported" | "changed" | "installed" | "updates" | "unfinished";
type Sort = "recent" | "title";

const FACETS: { id: Facet; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Written here" },
  { id: "imported", label: "Imported" },
  { id: "changed", label: "Changed here" },
  { id: "installed", label: "In projects" },
  { id: "updates", label: "Updates" },
  { id: "unfinished", label: "Drafts" },
];

const written = (s: LocalSkillSummary) =>
  s.origin.type === "created" || s.origin.type === "createdForProject" || s.origin.type === "instructions";

function matches(facet: Facet, s: LocalSkillSummary, standing: SkillStanding | undefined): boolean {
  switch (facet) {
    case "all":
      return true;
    case "mine":
      return written(s);
    case "imported":
      return !written(s);
    case "changed":
      return s.modifiedLocally === true;
    case "installed":
      return (standing?.installedIn.length ?? 0) > 0;
    case "updates":
      return standing?.upstream === "changed";
    case "unfinished":
      return s.errors > 0;
  }
}

function initial(title: string): string {
  const c = title.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

/** Today, this week, this month, earlier — landmarks for a long list. */
function when(iso: string): string {
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  return "Earlier";
}

/** Where the collection comes from, as threads: ink for your own, each library's dye. */
function Composition({ skills, dyes }: { skills: LocalSkillSummary[]; dyes: Map<string, Dye | undefined> }) {
  const parts = new Map<string, { label: string; count: number; color: string; community: boolean }>();
  for (const s of skills) {
    const key = s.origin.type === "library" ? `lib:${s.origin.sourceName}` : written(s) ? "mine" : "copied";
    const dye = s.origin.type === "library" ? dyes.get(s.origin.sourceName) : undefined;
    const label =
      s.origin.type === "library"
        ? `from ${s.origin.sourceName}`
        : written(s)
          ? "written here"
          : "copied from folders";
    const color = key === "mine" ? "var(--ink-soft)" : (dye?.color ?? "var(--hairline-strong)");
    const prev = parts.get(key);
    parts.set(key, { label, color, community: dye?.community ?? false, count: (prev?.count ?? 0) + 1 });
  }
  const list = [...parts.values()].sort((a, b) => b.count - a.count);
  return (
    <figure className="mys-weave" aria-label="Where your skills come from">
      <div className="mys-weave-bar" aria-hidden="true">
        {list.map((p) => (
          <span
            key={p.label}
            className={p.community ? "is-stitched" : undefined}
            style={{ flexGrow: p.count, background: p.color, color: p.color }}
          />
        ))}
      </div>
      <figcaption className="mys-weave-legend">
        {list.map((p) => (
          <span key={p.label}>
            <span className="mys-weave-swatch" style={{ background: p.color }} aria-hidden="true" />
            {p.count} {p.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Where a skill stands, in a word: Ready, or Draft and what is missing. */
function standingWord(s: LocalSkillSummary): { ready: boolean; text: string } {
  if (s.errors === 0) return { ready: true, text: "Ready" };
  if (!s.description.trim()) return { ready: false, text: "Draft · missing purpose" };
  return { ready: false, text: `Draft · ${plural(s.errors, "thing")} to finish` };
}

function Row({
  s,
  standing,
  letter,
  onOpen,
  onKeyDown,
  onUse,
  onShare,
  onExport,
  onTrash,
}: {
  s: LocalSkillSummary;
  standing: SkillStanding | undefined;
  letter: string | null;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onUse: () => void;
  onShare: () => void;
  onExport: () => void;
  onTrash: () => void;
}) {
  const installed = standing?.installedIn ?? [];
  const word = standingWord(s);
  const passOn = onward(s);
  const thread = isCopy(s.origin) || s.origin.type === "instructions" || Boolean(standing?.upstream);
  return (
    <li className="mys-item">
      <button type="button" className="mys-row" onClick={onOpen} onKeyDown={onKeyDown}>
        <span className="mys-letter" aria-hidden="true">
          {letter}
        </span>
        <span className="mys-main">
          <span className="mys-title">{s.title || "Untitled skill"}</span>
          <span className="mys-purpose">
            {s.description ? purpose(s.description) : <span className="mys-none">No purpose yet</span>}
          </span>
          {thread || installed.length > 0 ? (
            <span className="mys-thread">
              {/* Only knowledge that came from somewhere has a thread to show; your own needs no label. */}
              {thread ? <Provenance summary={s} standing={standing} /> : null}
              {installed.length > 0 ? (
                <span className="mys-used" title={installed.map((p) => p.projectName).join(", ")}>
                  in {installed.length === 1 ? installed[0]?.projectName : `${installed.length} projects`}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="mys-side">
          <span className={`mys-state${word.ready ? " is-ready" : " is-draft"}`}>
            <span className="mys-dot" aria-hidden="true" />
            {word.text}
          </span>
          <span className="mys-edited mono">{relativeTime(s.updatedAt)}</span>
        </span>
      </button>
      {/* What you would open a skill only to do, where the skill is: shown when the row is pointed at or focused. */}
      <span className="mys-acts">
        {word.ready && passOn ? (
          <Button size="sm" onClick={onShare} aria-label={`${passOn} ${s.title || "Untitled skill"}`}>
            {passOn}
          </Button>
        ) : null}
        {word.ready ? (
          <Button
            size="sm"
            variant="primary"
            onClick={onUse}
            aria-label={`Use ${s.title || "Untitled skill"}`}
          >
            Use
          </Button>
        ) : null}
        <Menu
          label={`More for ${s.title || "Untitled skill"}`}
          items={[
            ...(word.ready
              ? [{ label: "Export as zip…", icon: "download" as const, onSelect: onExport }]
              : []),
            { label: "Move to trash", icon: "trash" as const, danger: true, onSelect: onTrash },
          ]}
        />
      </span>
    </li>
  );
}

export function SkillsView({ skillId }: { skillId?: string }) {
  const skills = useSkills();
  const overview = useSkillsOverview(!skillId);
  const sources = useSources();
  const { navigate } = useNav();
  const { newSkill, addSkills } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [showTrash, setShowTrash] = useState(false);
  const [purging, setPurging] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [using, setUsing] = useState<LocalSkill | null>(null);
  const [sharing, setSharing] = useState<LocalSkill | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);

  const all = skills.data ?? [];
  const live = useMemo(() => all.filter((s) => s.deletedAt === null), [all]);
  const trash = all.filter((s) => s.deletedAt !== null);
  const standing = useMemo(() => new Map((overview.data ?? []).map((s) => [s.skillId, s])), [overview.data]);
  const dyes = useMemo(() => {
    const map = dyeMap(sources.data ?? []);
    return new Map((sources.data ?? []).map((src) => [src.name, map.get(src.id)]));
  }, [sources.data]);

  const counts = useMemo(() => {
    const out = {} as Record<Facet, number>;
    for (const f of FACETS) out[f.id] = live.filter((s) => matches(f.id, s, standing.get(s.id))).length;
    return out;
  }, [live, standing]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = live
      .filter((s) => matches(facet, s, standing.get(s.id)))
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.name.includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.origin.type === "library" && s.origin.sourceName.toLowerCase().includes(q)),
      );
    return sort === "title"
      ? [...filtered].sort((a, b) => (a.title || "~").localeCompare(b.title || "~"))
      : [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [live, facet, query, sort, standing]);

  // "/" finds, from anywhere on the page that is not already a text field.
  useEffect(() => {
    if (skillId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, [contenteditable]")) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skillId]);

  if (skillId) {
    return (
      <Suspense fallback={<Working>Opening the skill…</Working>}>
        <SkillStudio key={skillId} id={skillId} />
      </Suspense>
    );
  }
  if (skills.isPending) return <Working>Loading your skills…</Working>;
  if (skills.isError) return <ErrorNotice error={skills.error} />;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      invalidateSkills(client);
      toast.show(done);
    } catch (e) {
      setError(e);
    }
  };

  const use = async (id: string) => {
    setError(null);
    try {
      setUsing(await api.getSkill(id));
    } catch (e) {
      setError(e);
    }
  };

  const share = async (id: string) => {
    setError(null);
    try {
      setSharing(await api.getSkill(id));
    } catch (e) {
      setError(e);
    }
  };

  const exportZip = async (id: string) => {
    setError(null);
    try {
      const path = await api.exportSkill(id);
      if (path) toast.show(`Saved ${path}.`);
    } catch (e) {
      setError(e);
    }
  };

  const moveToTrash = async (s: LocalSkillSummary) => {
    setError(null);
    try {
      await api.trashSkill(s.id);
      invalidateSkills(client);
      toast.show(`“${s.title || "Untitled skill"}” moved to the trash.`, "ok", {
        label: "Undo",
        run: () => void act(() => api.restoreSkill(s.id), `“${s.title || "Untitled skill"}” restored.`),
      });
    } catch (e) {
      setError(e);
    }
  };

  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>(".mys-row") ?? [])];
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const every = rows();
    const at = every.indexOf(e.currentTarget);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown" || e.key === "j") next = every[at + 1];
    else if (e.key === "ArrowUp" || e.key === "k") next = at === 0 ? undefined : every[at - 1];
    else if (e.key === "Home") next = every[0];
    else if (e.key === "End") next = every[every.length - 1];
    else return;
    e.preventDefault();
    if (next) next.focus();
    else if (e.key === "ArrowUp" || e.key === "k") search.current?.focus();
  };

  const trashSection =
    trash.length > 0 ? (
      <section className="skills-trash" aria-labelledby="trash-title">
        <button
          type="button"
          id="trash-title"
          className="link-btn"
          aria-expanded={showTrash}
          onClick={() => setShowTrash((s) => !s)}
        >
          <Icon name={showTrash ? "chevronDown" : "chevronRight"} />
          Trash ({trash.length})
        </button>
        {showTrash ? (
          <ul className="skill-list">
            {trash.map((s) => (
              <li key={s.id} className="trash-row">
                <span className="skill-row-main">
                  <span className="skill-row-title">{s.title || "Untitled skill"}</span>
                  <span className="skill-row-meta">Moved to the trash {relativeTime(s.deletedAt)}</span>
                </span>
                <span className="trash-actions">
                  <Button
                    size="sm"
                    onClick={() => void act(() => api.restoreSkill(s.id), `“${s.title}” restored.`)}
                  >
                    Restore
                  </Button>
                  {purging === s.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setPurging(null);
                          void act(() => api.purgeSkill(s.id), `“${s.title}” deleted.`);
                        }}
                      >
                        Delete for good
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setPurging(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => setPurging(s.id)}>
                      Delete permanently…
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    ) : null;

  if (live.length === 0) {
    return (
      <div className="page skills is-empty">
        <header className="skills-head">
          <h1 className="page-title">My skills</h1>
        </header>
        {error ? <ErrorNotice error={error} /> : null}
        <SkillsEmpty />
        <OnThisMachine />
        {trashSection}
      </div>
    );
  }

  // Landmarks: letters when sorted by title, time when sorted by edit.
  let previous: string | null = null;
  const groupOf = (s: LocalSkillSummary) => (sort === "title" ? initial(s.title) : when(s.updatedAt));

  return (
    <div className="page mys">
      <header className="mys-head">
        <div className="mys-intro">
          <h1 className="page-title">My skills</h1>
          <p className="mys-lead">Your knowledge, gathered and refined.</p>
          <Composition skills={live} dyes={dyes} />
        </div>
        <div className="mys-actions">
          <Button icon="plus" onClick={() => addSkills()}>
            Add skills…
          </Button>
          <Button variant="primary" icon="pencil" onClick={() => newSkill()}>
            New skill
          </Button>
        </div>
      </header>
      {error ? <ErrorNotice error={error} /> : null}

      <div className="mys-tools">
        <label className="mys-search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            type="search"
            aria-label="Find a skill"
            value={query}
            placeholder="Find a skill"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                rows()[0]?.focus();
              } else if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
          />
          <span className="mys-kbd" aria-hidden="true">
            /
          </span>
        </label>
        <fieldset className="mys-facets">
          <legend className="visually-hidden">Show</legend>
          {FACETS.filter((f) => f.id === "all" || counts[f.id] > 0 || facet === f.id).map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={facet === f.id}
              className={facet === f.id ? "is-on" : undefined}
              onClick={() => setFacet(f.id)}
            >
              {f.label}
              <span className="mys-count">{counts[f.id]}</span>
            </button>
          ))}
        </fieldset>
        <fieldset className="studio-switch mys-sort">
          <legend className="visually-hidden">Order</legend>
          <button
            type="button"
            aria-pressed={sort === "recent"}
            className={sort === "recent" ? "is-on" : undefined}
            onClick={() => setSort("recent")}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={sort === "title"}
            className={sort === "title" ? "is-on" : undefined}
            onClick={() => setSort("title")}
          >
            A–Z
          </button>
        </fieldset>
      </div>

      {shown.length === 0 ? (
        <p className="mys-empty">
          No skill matches{query ? ` “${query}”` : ""}.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setQuery("");
              setFacet("all");
            }}
          >
            Show all
          </button>
        </p>
      ) : null}
      <ol className="mys-rows" ref={list} aria-label="Skills">
        {shown.map((s) => {
          const group = groupOf(s);
          const fresh = group !== previous;
          previous = group;
          return (
            <Fragment key={s.id}>
              {fresh && sort === "recent" && !query ? (
                <li className="mys-group" aria-hidden="true">
                  <span className="kicker">{group}</span>
                </li>
              ) : null}
              <Row
                s={s}
                standing={standing.get(s.id)}
                letter={sort === "title" && fresh && !query ? group : null}
                onOpen={() => navigate({ name: "skills", skillId: s.id })}
                onKeyDown={onRowKey}
                onUse={() => void use(s.id)}
                onShare={() => void share(s.id)}
                onExport={() => void exportZip(s.id)}
                onTrash={() => void moveToTrash(s)}
              />
            </Fragment>
          );
        })}
      </ol>

      <OnThisMachine />
      {trashSection}
      {sharing ? (
        <ShareSkillDialog
          skill={sharing}
          onClose={() => setSharing(null)}
          onFix={() => {
            setSharing(null);
            navigate({ name: "skills", skillId: sharing.summary.id });
          }}
        />
      ) : null}
      {using ? (
        <UseSkillDialog
          skill={using}
          onClose={() => setUsing(null)}
          onFix={() => {
            setUsing(null);
            navigate({ name: "skills", skillId: using.summary.id });
          }}
        />
      ) : null}
    </div>
  );
}
