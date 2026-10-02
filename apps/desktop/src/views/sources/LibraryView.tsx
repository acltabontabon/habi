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
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Source } from "../../bindings/Source";
import { Icon } from "../../components/Icon";
import { Button, Empty, ErrorNotice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { useActions } from "../../lib/actions";
import { type Dye, useDyes } from "../../lib/dye";
import { freshnessText, levelLabel, plural, relativeTime } from "../../lib/format";
import { useInspectorOpen } from "../../lib/inspector";
import { useNav } from "../../lib/nav";
import { useLibrary, useRefreshSource } from "../../lib/queries";
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
import { repositoryLabel, SourceSheet } from "./SourceSheet";

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
  onSelect,
  onKeyDown,
}: {
  item: LibraryItem;
  /** The first skill under a letter carries it, like an index. */
  letter: string | null;
  active: boolean;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const code = codeFiles(item);
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
  onSheet: () => void;
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
      (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.id.includes(q),
    );
  }, [all, query]);

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
    const index = items.findIndex((i) => i.id === selectedId);
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    const next =
      e.key === "Home"
        ? items[0]
        : e.key === "End"
          ? items[items.length - 1]
          : items[Math.max(0, Math.min(items.length - 1, index + step))];
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
          <button
            type="button"
            className="index-repo"
            onClick={onSheet}
            title={`${repositoryLabel(source.location)} — where it comes from`}
          >
            {shortRepo(source)}
          </button>
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
              const first = items[0];
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
        {items.map((i) => {
          const letter = query ? null : initial(i.title);
          const shown = letter !== previous ? letter : null;
          if (letter) previous = letter;
          return (
            <IndexRow
              key={i.id}
              item={i}
              letter={shown}
              active={i.id === selectedId}
              onSelect={() => onOpen(i)}
              onKeyDown={onKeyDown}
            />
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
  dye,
  libraryName,
  position,
  details,
  onDetails,
  onFocusIndex,
}: {
  item: LibraryItem;
  source: Source;
  dye: Dye;
  libraryName: string;
  position: string;
  details: boolean;
  onDetails: () => void;
  onFocusIndex: () => void;
}) {
  const { addSkills } = useActions();
  const pkg = usePackage();
  const [adding, setAdding] = useState(false);
  const shape = pkg?.shape ?? packageShape(item.files);
  const summary = summarize(item.description);
  const lineage = item.basedOn ? lineageParts(item.basedOn) : null;
  const community = source.role === "community";
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
          {community ? "community · not team-reviewed" : "team library"}
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
            </span>
            {item.owner ? <span className="muted"> · {item.owner}</span> : null}
          </dd>
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
  const [sheet, setSheet] = useState(false);
  const [details, setDetails] = useState(false);
  const [inspector] = useInspectorOpen();
  const narrow = useMedia("(max-width: 980px)");
  // Opening the package folds the index into the library's spine: the
  // skill and its contents get the room; the index is one hover away.
  const layout: Layout = narrow ? "bar" : inspector ? "spine" : "full";
  const [peek, setPeek] = useState(false);
  const [reading, setReading] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const rail = useRef<HTMLElement>(null);
  const readerBox = useRef<HTMLElement>(null);

  const all = library.data?.items ?? [];
  const name = library.data?.name ?? source.name;
  const selected = all.find((i) => i.id === itemId) ?? all[0] ?? null;
  const position = selected ? `${all.indexOf(selected) + 1} / ${all.length}` : "";

  useEffect(() => {
    if (layout === "full") setPeek(false);
  }, [layout]);

  // Reading: the index steps back until it is pointed at again.
  useEffect(() => {
    const box = readerBox.current;
    if (!box) return;
    const onScroll = () => setReading(box.scrollTop > 120);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);

  const open = (item: LibraryItem) => navigate({ name: "sources", sourceId: source.id, itemId: item.id });
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
              path === null
                ? navigate({ name: "sources", sourceId: source.id, itemId: selected.id })
                : navigate({ name: "sources", sourceId: source.id, itemId: selected.id, file: path })
            }
            head={
              <SkillHead
                item={selected}
                source={source}
                dye={dye}
                libraryName={name}
                position={position}
                details={details}
                onDetails={() => setDetails((d) => !d)}
                onFocusIndex={focusIndex}
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
