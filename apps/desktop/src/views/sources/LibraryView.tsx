/**
 * A library: a body of knowledge, and one piece of it being read.
 *
 * The index is the library's warp: its thread runs down the rail and every
 * skill is a pick across it — name, what it is for, and quiet marks for
 * what is special (scripts, rules). Type to filter, ↑/↓ or j/k to move,
 * Enter to read. The chosen skill is the protagonist: a short head (what it
 * is, one primary action, an engineering signature), then its document.
 * Everything else is reachable without leaving it: details unfold under
 * the signature, the package opens beside the document (⌘I) while the
 * index folds into the library's spine, one hover away. Where the knowledge comes from is a sheet opened from the
 * library's address.
 */
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogEntry } from "../../bindings/CatalogEntry";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Recommendation } from "../../bindings/Recommendation";
import type { Source } from "../../bindings/Source";
import { BackLink } from "../../components/BackLink";
import { Icon } from "../../components/Icon";
import { Button, Empty, ErrorNotice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { useActions } from "../../lib/actions";
import { countSignals, groupItems, shortCommit, worstSignal } from "../../lib/catalog";
import { type Dye, useDyes } from "../../lib/dye";
import { freshnessText, levelLabel, plural, relativeTime } from "../../lib/format";
import { useInspectorOpen } from "../../lib/inspector";
import { lastProject, type Route, useNav } from "../../lib/nav";
import {
  useCatalog,
  useCatalogFits,
  useLibrary,
  useRecentProjects,
  useRefreshSource,
  useSkills,
  useUpdateReport,
} from "../../lib/queries";
import {
  codeFiles,
  describeCondition,
  licenseText,
  lineageParts,
  packageShape,
  summarize,
} from "../../lib/skillFacts";
import { useMedia } from "../../lib/useMedia";
import { ContentsToggle, SkillReader, usePackage } from "../reader/SkillReader";
import { SampleBanner } from "../SampleWorkspace";
import { AddToProjectDialog } from "./AddToProjectDialog";
import { DisconnectButton } from "./DisconnectButton";
import { LibraryStrip } from "./LibraryStrip";
import { SignalList } from "./Signals";
import { repositoryLabel, SourceSheet } from "./SourceSheet";
import { changesOf, LibraryUpdates } from "./UpdateNotes";

/** "github.com/anthropics/skills" → "anthropics/skills": the host rarely helps. */
function shortRepo(source: Source): string {
  const label = repositoryLabel(source.location).replace(/^(github\.com|gitlab\.com|codeberg\.org)\//, "");
  return source.subdir ? `${label} › ${source.subdir}` : label;
}

function initial(title: string): string {
  const c = title.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

/* ---------- The index ---------- */

function IndexRow({
  item,
  letter,
  active,
  fits,
  changed,
  onSelect,
  onKeyDown,
}: {
  item: LibraryItem;
  /** The first skill under a letter carries it, like an index. */
  letter: string | null;
  active: boolean;
  /** Fits the project being worked on. */
  fits: boolean;
  /** New or changed in the last update, until it is marked as seen. */
  changed: "new" | "changed" | undefined;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const code = codeFiles(item);
  const flagged = worstSignal(item) === "caution";
  return (
    <li>
      <button
        type="button"
        data-key={item.id}
        className={`index-row${active ? " is-active" : ""}`}
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className="index-letter mono" aria-hidden="true">
          {letter}
        </span>
        <span className="index-title">{item.title}</span>
        <span className="index-marks mono">
          {item.kind === "instructions" ? <span>instructions</span> : null}
          {item.kind === "workflow" ? <span>workflow</span> : null}
          {item.requirement === "required" ? <span>required</span> : null}
          {item.metadataStatus === "declared" ? <span>rules</span> : null}
          {changed ? <span className="index-changed">{changed}</span> : null}
          {fits ? <span className="index-fit">fits</span> : null}
          {flagged ? (
            <span className="index-flag">
              <Icon name="warning" size={11} />
              <span className="visually-hidden">caution signals</span>
            </span>
          ) : null}
          {code > 0 ? (
            <span className="index-runs">
              <Icon name="terminal" size={11} />
              {code}
              <span className="visually-hidden"> {code === 1 ? "script" : "scripts"}</span>
            </span>
          ) : null}
        </span>
        <span className="index-desc">{summarize(item.description).text}</span>
      </button>
    </li>
  );
}

function IndexPanel({
  source,
  dye,
  name,
  all,
  selectedId,
  onOpen,
  onRead,
  onSheet,
  groupSegment,
  fitIds,
  changes,
  id,
}: {
  source: Source;
  dye: Dye;
  name: string;
  all: LibraryItem[];
  selectedId: string | undefined;
  onOpen: (item: LibraryItem) => void;
  /** Enter: go and read the chosen skill. */
  onRead: () => void;
  /** Where the library comes from; a preview has no sheet (its strip says it). */
  onSheet?: () => void;
  /** The path segment whose folders group the skills (a plugin, a product area). */
  groupSegment: number | null;
  /** Skills that fit the project being worked on. */
  fitIds: ReadonlySet<string>;
  /** What the last update changed, by skill. */
  changes: ReadonlyMap<string, "new" | "changed">;
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const fresh = freshnessText(source);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.id.includes(q) ||
        i.path.toLowerCase().includes(q),
    );
  }, [all, query]);
  // Grouped, the list reads group by group; the arrow keys follow what is on screen.
  const groups = useMemo(() => groupItems(items, groupSegment), [items, groupSegment]);

  const focusRow = (key: string | undefined) =>
    requestAnimationFrame(() =>
      (key
        ? list.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(key)}"]`)
        : list.current?.querySelector<HTMLButtonElement>(".index-row")
      )?.focus(),
    );

  // "/" finds a skill in this library from anywhere on the page.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if (!filter.current || filter.current.offsetParent === null) return;
      e.preventDefault();
      filter.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onRead();
      return;
    }
    // Typing in the index filters it: no search box to find first.
    if (
      e.key.length === 1 &&
      /\S/.test(e.key) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !"jk".includes(e.key)
    ) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      filter.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "j", "k", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const ordered = groups.flatMap((g) => g.items);
    const index = ordered.findIndex((i) => i.id === selectedId);
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    const next =
      e.key === "Home"
        ? ordered[0]
        : e.key === "End"
          ? ordered[ordered.length - 1]
          : ordered[Math.max(0, Math.min(ordered.length - 1, index + step))];
    if (!next) return;
    onOpen(next);
    focusRow(next.id);
  };

  let previous = "";
  return (
    <div className="index-panel" id={id}>
      <header className="index-id">
        <h1 className="index-name">{name}</h1>
        <span className="index-count mono" title={plural(all.length, "skill")}>
          {all.length}
        </span>
        <p className="index-source mono">
          {onSheet ? (
            <button
              type="button"
              className="index-repo"
              onClick={onSheet}
              title={`${repositoryLabel(source.location)} — where it comes from`}
            >
              {shortRepo(source)}
            </button>
          ) : (
            <span className="index-repo">{shortRepo(source)}</span>
          )}
          <span
            title={source.role === "community" ? "Published by others; not reviewed by your team" : undefined}
          >
            {" · "}
            {source.role === "community" ? "community" : "team"}
          </span>
          {source.freshness !== "current" ? (
            <span
              className={fresh.tone === "muted" || fresh.tone === "ok" ? undefined : `tone-${fresh.tone}`}
            >
              {" · "}
              {fresh.text}
            </span>
          ) : source.snapshotAt ? (
            <span className="index-fresh"> · {relativeTime(source.snapshotAt)}</span>
          ) : null}
        </p>
      </header>
      <div className="index-filter">
        <Icon name="search" size={12} />
        <label className="visually-hidden" htmlFor={`${id ?? "index"}-filter`}>
          Filter skills in {name}
        </label>
        <input
          ref={filter}
          id={`${id ?? "index"}-filter`}
          type="search"
          placeholder={`Filter ${plural(all.length, "skill")}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              const first = groups[0]?.items[0];
              if (first) {
                onOpen(first);
                focusRow(first.id);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (query) setQuery("");
              else focusRow(selectedId);
            }
          }}
        />
        {!query ? (
          <span className="index-kbd" aria-hidden="true">
            /
          </span>
        ) : null}
      </div>
      <ol
        className={`index-list${dye.community ? " is-stitched" : ""}`}
        ref={list}
        style={{ "--warp": dye.color } as CSSProperties}
        aria-label={`Skills in ${name}`}
      >
        {groups.map((g) => {
          // Letters index an alphabetical list; a grouped list is indexed by its groups.
          previous = "";
          return (
            <Fragment key={g.name ?? "(other)"}>
              {groupSegment !== null ? (
                <li className="index-group">
                  <span className="index-group-name mono">{g.name ?? "Other"}</span>
                  <span className="index-group-count mono">{g.items.length}</span>
                </li>
              ) : null}
              {g.items.map((i) => {
                const letter = query || groupSegment !== null ? null : initial(i.title);
                const shown = letter !== previous ? letter : null;
                if (letter) previous = letter;
                return (
                  <IndexRow
                    key={i.id}
                    item={i}
                    letter={shown}
                    active={i.id === selectedId}
                    fits={fitIds.has(i.id)}
                    changed={changes.get(i.id)}
                    onSelect={() => onOpen(i)}
                    onKeyDown={onKeyDown}
                  />
                );
              })}
            </Fragment>
          );
        })}
      </ol>
      {items.length === 0 && query ? <p className="index-empty muted">Nothing matches “{query}”.</p> : null}
    </div>
  );
}

/* ---------- The skill's head ---------- */

function SkillHead({
  item,
  source,
  entry,
  dye,
  libraryName,
  position,
  details,
  fit,
  projectName,
  onDetails,
  onOpenDetails,
  onFocusIndex,
  onOpenFile,
}: {
  item: LibraryItem;
  source: Source;
  entry: CatalogEntry | undefined;
  dye: Dye;
  libraryName: string;
  position: string;
  details: boolean;
  /** This skill fits the project being worked on, with Habi's reason. */
  fit: Recommendation | undefined;
  projectName: string | null;
  onDetails: () => void;
  onOpenDetails: () => void;
  onFocusIndex: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { addSkills } = useActions();
  const pkg = usePackage();
  const [adding, setAdding] = useState(false);
  const shape = pkg?.shape ?? packageShape(item.files);
  const summary = summarize(item.description);
  const lineage = item.basedOn ? lineageParts(item.basedOn) : null;
  const community = source.role === "community";
  const signals = countSignals(item);
  const rules = item.appliesWhen
    ? `applies when ${describeCondition(item.appliesWhen)}${item.excludes ? `, unless ${describeCondition(item.excludes)}` : ""}`
    : null;

  const signature: ReactNode[] = [];
  if (shape.code.length > 0) {
    signature.push(
      <button
        key="runs"
        type="button"
        className="sig-runs"
        onClick={() => pkg?.reveal({ kind: "code" })}
        title="Files an agent could run once installed — see which"
      >
        <Icon name="terminal" size={12} />
        {plural(shape.code.length, "script")}
      </button>,
    );
  }
  signature.push(<span key="files">{plural(shape.count, "file")}</span>);
  if (shape.languages.length > 0) {
    signature.push(
      <span key="langs" title={shape.languages.map((l) => l.label).join(" · ")}>
        {shape.languages.length} languages
      </span>,
    );
  }
  signature.push(
    rules ? (
      <span key="rules" className="sig-rules" title={rules}>
        {rules}
      </span>
    ) : (
      <span
        key="rules"
        className="sig-quiet"
        title="Habi does not recommend it on its own; use it deliberately"
      >
        no project rules
      </span>
    ),
  );
  if (signals.caution > 0) {
    signature.push(
      <button
        key="caution"
        type="button"
        className="sig-runs is-caution"
        onClick={onOpenDetails}
        title="Habi noticed things in these files worth reading before you adopt the skill — see what"
      >
        <Icon name="warning" size={12} />
        {plural(signals.caution, "caution signal")}
      </button>,
    );
  } else if (signals.notice > 0) {
    signature.push(
      <button
        key="notice"
        type="button"
        className="sig-quiet sig-link"
        onClick={onOpenDetails}
        title="See what Habi noticed in these files"
      >
        {plural(signals.notice, "notice")}
      </button>,
    );
  }
  if (item.licenseRestricted)
    signature.push(
      <span key="lic" className="sig-warn">
        proprietary licence
      </span>,
    );
  if (lineage) {
    signature.push(
      <span key="lineage" className="sig-quiet" title={item.basedOn ?? undefined}>
        based on {lineage.item}
      </span>,
    );
  }

  return (
    <header className="skill-head">
      <p className="skill-coord">
        <Strand dye={dye} size={14} />
        <button type="button" className="skill-coord-lib" onClick={onFocusIndex} title="Back to the index">
          {libraryName}
        </button>
        <span className="skill-coord-trust">
          {entry?.ownership ? "not audited" : community ? "community · not team-reviewed" : "team library"}
        </span>
        <span className="skill-coord-pos mono">{position}</span>
      </p>
      <div className="skill-title-row">
        <h2 className="skill-head-title">{item.title}</h2>
        <div className="skill-actions">
          <Button variant="primary" icon="download" onClick={() => setAdding(true)}>
            Add to a project…
          </Button>
          {item.kind !== "instructions" ? (
            <button
              type="button"
              className="link-quiet"
              title={`Copies the whole package to My skills, linked to ${source.name}`}
              onClick={() => addSkills({ source: "library", sourceId: source.id, preselect: item.id })}
            >
              Edit a copy
            </button>
          ) : null}
        </div>
      </div>
      <p className="skill-purpose">{summary.text}</p>
      {fit ? (
        <p className="skill-fit">
          <Icon name="check" size={12} />
          <span>
            Fits {projectName ?? "your project"}: {fit.applicability.reason}.{" "}
            {fit.basis === "catalogHint" ? (
              <span className="muted">Suggested by Habi's catalog; the author declared no rules.</span>
            ) : (
              <span className="muted">From the author's own rules.</span>
            )}
          </span>
        </p>
      ) : null}
      <div className="skill-sig">
        <p className="sig mono">{signature}</p>
        <div className="sig-tools">
          <button
            type="button"
            className="sig-toggle"
            aria-expanded={details}
            aria-controls="skill-details"
            onClick={onDetails}
          >
            Details
            {item.diagnostics.length > 0 ? (
              <span className="sig-count mono">{item.diagnostics.length}</span>
            ) : null}
            <Icon name="chevronDown" size={12} />
          </button>
          <ContentsToggle />
        </div>
      </div>
      {details ? (
        <dl className="skill-details" id="skill-details">
          {summary.shortened ? (
            <>
              <dt>Description</dt>
              <dd className="skill-details-desc">{item.description}</dd>
            </>
          ) : null}
          <dt>Applies</dt>
          <dd>{rules ?? "No rules — Habi does not recommend it on its own; use it deliberately."}</dd>
          {item.tools.length > 0 ? (
            <>
              <dt>Needs</dt>
              <dd>
                {item.tools.map((t) => (
                  <span key={t.name} className="skill-details-tool">
                    {t.name} <span className="mono muted">{t.commands.join(", ")}</span>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {item.clients ? (
            <>
              <dt>For</dt>
              <dd>{item.clients.join(", ")}</dd>
            </>
          ) : null}
          <dt>Licence</dt>
          <dd className={item.licenseRestricted ? "tone-warn" : undefined}>
            {licenseText(item.license, item.licenseFile)}
          </dd>
          <dt>Location</dt>
          <dd>
            <span className="mono">
              {shortRepo(source)} › {item.path}
              {source.snapshot && source.kind === "git" ? ` @ ${shortCommit(source.snapshot)}` : ""}
            </span>
            {item.owner ? <span className="muted"> · {item.owner}</span> : null}
            {entry ? <span className="muted"> · published by {entry.publisher.name}</span> : null}
          </dd>
          {item.kind !== "instructions" ? (
            <>
              <dt>Inspection</dt>
              <dd>
                <SignalList item={item} onOpenFile={onOpenFile} />
              </dd>
            </>
          ) : null}
          {item.basedOn ? (
            <>
              <dt>Lineage</dt>
              <dd className="mono">{item.basedOn}</dd>
            </>
          ) : null}
          {item.diagnostics.length > 0 ? (
            <>
              <dt>Notes</dt>
              <dd>
                <ul className="skill-details-notes">
                  {item.diagnostics.map((d, i) => (
                    <li key={i}>
                      <strong>{levelLabel(d.level)}</strong>{" "}
                      {d.path ? <span className="mono">{d.path}: </span> : null}
                      {d.message}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {adding ? <AddToProjectDialog item={item} onClose={() => setAdding(false)} /> : null}
    </header>
  );
}

/* ---------- The library ---------- */

type Layout = "full" | "spine" | "bar";

export function LibraryView({ source, itemId, file }: { source: Source; itemId?: string; file?: string }) {
  const { navigate } = useNav();
  const library = useLibrary(source.id, Boolean(source.snapshot));
  const refresh = useRefreshSource();
  const dye = useDyes()(source.id);
  const catalog = useCatalog();
  const entry = catalog.data?.find((e) => e.sourceId === source.id);
  const skills = useSkills();
  const projects = useRecentProjects();
  const projectId = lastProject() ?? undefined;
  const projectName = projects.data?.find((p) => p.id === projectId)?.name ?? null;
  const fits = useCatalogFits(entry ? projectId : undefined);
  const fitByItem = useMemo(
    () =>
      new Map<string, Recommendation>(
        (fits.data?.find((f) => f.entryId === entry?.id)?.fits ?? []).map((r) => [r.item.id, r]),
      ),
    [fits.data, entry?.id],
  );
  const fitIds = useMemo(() => new Set(fitByItem.keys()), [fitByItem]);
  const updateReport = useUpdateReport(source.snapshot ? source.id : undefined).data;
  const changes = useMemo(() => changesOf(updateReport), [updateReport]);
  const adopted = entry
    ? (skills.data ?? []).filter(
        (s) =>
          s.origin.type === "library" &&
          (s.origin.upstream?.catalogId === entry.id || s.origin.sourceName === source.name),
      ).length
    : 0;
  const route = (i: string | undefined, f?: string): Route => ({
    name: "sources",
    sourceId: source.id,
    itemId: i,
    file: f,
  });
  const [sheet, setSheet] = useState(false);
  const [details, setDetails] = useState(false);
  const [inspector, setInspector] = useInspectorOpen();
  const narrow = useMedia("(max-width: 980px)");
  // Opening the package folds the index into the library's spine: the
  // skill and its contents get the room; the index is one hover away.
  const layout: Layout = narrow ? "bar" : inspector ? "spine" : "full";
  const [peek, setPeek] = useState(false);
  const [reading, setReading] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const rail = useRef<HTMLElement>(null);
  const readerBox = useRef<HTMLElement>(null);

  const groupSegment = entry?.groupSegment ?? null;
  const unsorted = library.data?.items;
  const all = useMemo(
    () => (unsorted ? groupItems(unsorted, groupSegment).flatMap((g) => g.items) : []),
    [unsorted, groupSegment],
  );
  const name = library.data?.name ?? entry?.name ?? source.name;
  const selected = all.find((i) => i.id === itemId) ?? all[0] ?? null;
  const position = selected ? `${all.indexOf(selected) + 1} / ${all.length}` : "";

  useEffect(() => {
    if (layout === "full") setPeek(false);
  }, [layout]);

  // Choosing another skill starts it folded: the package beside the document
  // is something you open for the skill you are curious about, not a setting
  // that follows you down the list.
  const shownId = selected?.id;
  const previousId = useRef(shownId);
  useEffect(() => {
    if (previousId.current !== undefined && previousId.current !== shownId) setInspector(false);
    previousId.current = shownId;
  }, [shownId, setInspector]);

  // Reading: the index steps back until it is pointed at again.
  useEffect(() => {
    const box = readerBox.current;
    if (!box) return;
    const onScroll = () => setReading(box.scrollTop > 120);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);

  const open = (item: LibraryItem) => navigate(route(item.id));
  const read = () => {
    setPeek(false);
    requestAnimationFrame(() => document.getElementById("reader-doc")?.focus({ preventScroll: true }));
  };
  const focusIndex = () => {
    if (layout !== "full") setPeek(true);
    requestAnimationFrame(() =>
      rail.current?.querySelector<HTMLButtonElement>(".index-row.is-active, .index-row")?.focus(),
    );
  };

  const hoverPeek = (next: boolean) => {
    if (layout === "full") return;
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(next), next ? 120 : 260);
  };

  const panel = source.snapshot ? (
    <IndexPanel
      id="library-index"
      source={source}
      dye={dye}
      name={name}
      all={all}
      selectedId={selected?.id}
      onOpen={(item) => open(item)}
      onRead={read}
      onSheet={() => setSheet(true)}
      groupSegment={groupSegment}
      fitIds={fitIds}
      changes={changes}
    />
  ) : null;

  return (
    <div className={`library is-${layout}${reading ? " is-reading" : ""}`}>
      <aside
        className={`library-index${peek ? " is-peeking" : ""}`}
        ref={rail}
        aria-label={`${name} index`}
        onMouseEnter={() => hoverPeek(true)}
        onMouseLeave={() => hoverPeek(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && peek) {
            e.preventDefault();
            e.stopPropagation();
            setPeek(false);
            rail.current?.querySelector<HTMLButtonElement>(".index-handle")?.focus();
          }
        }}
        onClick={(e) => {
          if (peek && (e.target as HTMLElement).closest(".index-row")) setPeek(false);
        }}
        onBlur={(e) => {
          if (layout !== "full" && !e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(false);
        }}
      >
        {layout !== "full" ? (
          <button
            type="button"
            className="index-handle"
            aria-expanded={peek}
            aria-controls="library-index"
            onClick={() => (peek ? setPeek(false) : focusIndex())}
            style={{ "--warp": dye.color } as CSSProperties}
          >
            <span className={`index-handle-warp${dye.community ? " is-stitched" : ""}`} aria-hidden="true" />
            <span className="index-handle-name">{name}</span>
            {layout === "bar" && selected ? (
              <span className="index-handle-skill">{selected.title}</span>
            ) : null}
            <span className="index-handle-pos mono">{position}</span>
            {layout === "bar" ? <Icon name="chevronDown" size={12} /> : null}
          </button>
        ) : null}
        {layout === "full" || peek ? panel : null}
        {library.isPending && source.snapshot ? <Working>Reading the library…</Working> : null}
        {library.isError ? <ErrorNotice error={library.error} /> : null}
      </aside>

      <section className="library-reader" ref={readerBox}>
        {source.sample ? <SampleBanner /> : null}
        {/* A catalog library carries its back link in its header; others get one of their own. */}
        {entry && library.data ? null : (
          <div className="library-back">
            <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />
            {source.sample ? null : <DisconnectButton source={source} />}
          </div>
        )}
        {entry && library.data ? (
          <LibraryStrip
            entry={entry}
            source={source}
            items={all}
            adopted={adopted}
            onOpen={(item, path) => navigate(path ? route(item.id, path) : route(item.id))}
          />
        ) : null}
        <LibraryUpdates source={source} items={all} onOpen={(item) => navigate(route(item.id))} />
        {!source.snapshot ? (
          <>
            <Empty
              title="Nothing fetched yet"
              action={
                <Button variant="primary" busy={refresh.isPending} onClick={() => refresh.mutate(source.id)}>
                  Fetch the library
                </Button>
              }
            >
              Fetching copies the library into Habi's cache. It never changes your projects.
            </Empty>
            {refresh.error ? <ErrorNotice error={refresh.error} title="The library was not fetched" /> : null}
          </>
        ) : selected ? (
          <SkillReader
            key={selected.id}
            sourceId={source.id}
            itemId={selected.id}
            title={selected.title}
            file={file ?? null}
            onFile={(path) =>
              path === null ? navigate(route(selected.id)) : navigate(route(selected.id, path))
            }
            head={
              <SkillHead
                item={selected}
                source={source}
                entry={entry}
                dye={dye}
                libraryName={name}
                position={position}
                details={details}
                fit={fitByItem.get(selected.id)}
                projectName={projectName}
                onDetails={() => setDetails((d) => !d)}
                onOpenDetails={() => setDetails(true)}
                onFocusIndex={focusIndex}
                onOpenFile={(path) => navigate(route(selected.id, path))}
              />
            }
          />
        ) : library.data ? (
          <Empty title="This library has no skills yet" />
        ) : null}
      </section>
      {sheet ? <SourceSheet source={source} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
