/**
 * Choosing a project, inside Habi. The folders themselves say what they are:
 * a project knots its thread and names its stack, a folder of skills is
 * stitched (a library, not a project), anything else is a faint thread to
 * follow down — and says how many repositories wait inside. Each repository
 * carries its last twelve weeks of commits on this machine as stitches, so
 * what you are working on now is easy to spot. Type to narrow by name,
 * stack, branch or remote. The native picker is still there for anywhere else.
 */
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { FolderEntry } from "../bindings/FolderEntry";
import type { ProjectPick } from "../bindings/ProjectPick";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { Button, ErrorNotice } from "../components/ui";
import { WaitingLoom } from "../components/Weaving";
import { api } from "../lib/api";
import { plural, relativeTime } from "../lib/format";
import { useRecentProjects } from "../lib/queries";
import { stackDye } from "../lib/stackDye";

type Place = { kind: "found" } | { kind: "folder"; path: string };

export function ProjectChooser({
  onOpen,
  onLibrary,
  onElsewhere,
  onClose,
}: {
  onOpen: (path: string) => void;
  onLibrary: (path: string) => void;
  /** The native picker, for anywhere the chooser does not go. */
  onElsewhere: () => void;
  onClose: () => void;
}) {
  const places = useQuery({ queryKey: ["projectPlaces"], queryFn: api.projectPlaces, staleTime: 0 });
  const recent = useRecentProjects();
  const [place, setPlace] = useState<Place | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);

  // Start where the projects are; with none found, at home.
  const here: Place | null =
    place ??
    (places.data
      ? places.data.found.length > 0
        ? { kind: "found" }
        : { kind: "folder", path: places.data.home.path }
      : null);
  const folderPath = here?.kind === "folder" ? here.path : null;
  const listing = useQuery({
    queryKey: ["browseFolder", folderPath],
    queryFn: () => api.browseFolder(folderPath ?? ""),
    enabled: folderPath !== null,
    staleTime: 10_000,
  });

  const found = here?.kind === "found";
  const opened = useMemo(() => new Set((recent.data ?? []).map((p) => p.path)), [recent.data]);
  const all: FolderEntry[] = found ? (places.data?.found ?? []) : (listing.data?.entries ?? []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = useMemo(
    () => (words.length === 0 ? all : all.filter((e) => words.every((w) => haystack(e).includes(w)))),
    [all, words],
  );
  // While narrowing, the best match is already chosen, so Enter opens it.
  const selected = picked ?? (words.length > 0 ? (entries[0]?.path ?? null) : null);
  const chosen = entries.find((e) => e.path === selected) ?? null;
  const loading = places.isPending || (folderPath !== null && listing.isPending);
  const error = places.error ?? (folderPath !== null ? listing.error : null);

  const go = (next: Place) => {
    setPlace(next);
    setPicked(null);
    setQuery("");
    filter.current?.focus();
  };
  const enter = (e: FolderEntry) => go({ kind: "folder", path: e.path });
  const act = (e: FolderEntry | null) => {
    if (!e) return;
    if (e.kind === "skills") onLibrary(e.path);
    else onOpen(e.path);
  };
  const up = () => {
    const parent = listing.data?.crumbs.at(-2);
    if (folderPath !== null && parent) go({ kind: "folder", path: parent.path });
  };

  useEffect(() => {
    if (!selected) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Keys go to the filter; arrows walk the list, and with nothing typed, the folders.
  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    const i = entries.findIndex((e) => e.path === selected);
    const move = (to: number) => {
      const e = entries[Math.max(0, Math.min(entries.length - 1, to))];
      if (e) setPicked(e.path);
    };
    const typed = query.length > 0;
    if (ev.key === "ArrowDown") move(i + 1);
    else if (ev.key === "ArrowUp") move(i < 0 ? 0 : i - 1);
    else if (ev.key === "ArrowRight" && !typed && chosen) enter(chosen);
    else if ((ev.key === "ArrowLeft" || ev.key === "Backspace") && !typed) up();
    else if (ev.key === "Enter") act(chosen);
    else return;
    ev.preventDefault();
  };

  const rail: { key: string; name: string; place: Place; count?: number }[] = places.data
    ? [
        ...(places.data.found.length > 0
          ? [{ key: "found", name: "Recent", place: { kind: "found" } as Place }]
          : []),
        ...places.data.roots.map((r) => ({
          key: r.path,
          name: r.name,
          count: r.projects,
          place: { kind: "folder", path: r.path } as Place,
        })),
      ]
    : [];
  const railKey = found ? "found" : folderPath;
  const crumbs = listing.data?.crumbs ?? [];
  const roots = (places.data?.roots ?? []).map((r) => `~/${r.name}`).join("  ");
  const repos = places.data?.found ?? [];
  const active = repos.filter((e) => (e.git?.weeks ?? []).slice(-4).some((n) => n > 0)).length;
  const woven = entries.some((e) => e.git);
  // Stitch lengths compare across the list: the busiest week shown is the longest.
  const busiest = Math.max(1, ...entries.flatMap((e) => e.git?.weeks ?? []));

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content
          className="dialog chooser"
          aria-describedby={undefined}
          onOpenAutoFocus={(ev) => {
            ev.preventDefault();
            filter.current?.focus();
          }}
        >
          <header className="chooser-head">
            <RadixDialog.Title className="chooser-title">Open a project</RadixDialog.Title>
            <nav className="chooser-crumbs" aria-label="Folder">
              {found ? (
                <span className="chooser-crumb" data-tip={`Found in ${roots}`}>
                  {plural(places.data?.total ?? repos.length, "repo")}
                  {active > 0 ? ` · ${active} active this month` : ""}
                </span>
              ) : (
                crumbs.map((c, i) => (
                  <span key={c.path} className="chooser-crumb-wrap">
                    {i > 0 ? <span className="chooser-crumb-sep">/</span> : null}
                    {i === crumbs.length - 1 ? (
                      <span className="chooser-crumb is-here">{i === 0 ? "~" : c.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="chooser-crumb"
                        onClick={() => go({ kind: "folder", path: c.path })}
                      >
                        {i === 0 ? "~" : c.name}
                      </button>
                    )}
                  </span>
                ))
              )}
            </nav>
            <RadixDialog.Close className="icon-btn" aria-label="Close">
              <Icon name="close" />
            </RadixDialog.Close>
          </header>

          <div className={`chooser-body${rail.length === 0 ? " is-bare" : ""}`}>
            <ul className="chooser-rail" aria-label="Places">
              {rail.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    className={`chooser-place${railKey === r.key ? " is-here" : ""}`}
                    aria-current={railKey === r.key ? "true" : undefined}
                    onClick={() => go(r.place)}
                  >
                    <span className="chooser-place-knot" aria-hidden="true" />
                    <span className="chooser-place-name">{r.name}</span>
                    {r.count ? <span className="chooser-place-count">{r.count}</span> : null}
                  </button>
                </li>
              ))}
            </ul>

            <div className="chooser-main">
              <label className="chooser-filter">
                <Icon name="search" />
                <input
                  ref={filter}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPicked(null);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="habi, rust, github.com/acme…"
                  aria-label="Narrow by name, stack, branch or remote"
                  aria-controls="chooser-list"
                  aria-activedescendant={chosen ? rowId(chosen) : undefined}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <div
                ref={list}
                id="chooser-list"
                key={railKey ?? "loading"}
                className="chooser-list"
                role="listbox"
                aria-label="Folders"
              >
                {error ? (
                  <div className="chooser-state">
                    <ErrorNotice error={error} title="This folder could not be read" />
                  </div>
                ) : loading ? (
                  <div className="chooser-state">
                    <WaitingLoom />
                  </div>
                ) : entries.length === 0 ? (
                  <p className="chooser-state chooser-empty">
                    {words.length > 0 ? "no match" : "nothing here"}
                  </p>
                ) : (
                  woven && (
                    <div className="chooser-scale" aria-hidden="true">
                      <span className="chooser-scale-weeks">
                        <span>12 weeks ago</span>
                        <span>now</span>
                      </span>
                    </div>
                  )
                )}
                {error || loading || entries.length === 0
                  ? null
                  : entries.map((e, i) => (
                      <Row
                        key={e.path}
                        entry={e}
                        index={i}
                        found={found}
                        opened={opened.has(e.display)}
                        selected={e.path === selected}
                        busiest={busiest}
                        onSelect={() => setPicked(e.path)}
                        onEnter={() => (e.kind === "folder" ? enter(e) : act(e))}
                        onInto={() => enter(e)}
                      />
                    ))}
                {listing.data?.truncated && !found ? (
                  <p className="chooser-more">first {all.length} folders</p>
                ) : null}
              </div>
            </div>
          </div>

          <footer className="chooser-foot">
            <Button variant="quiet" onClick={onElsewhere}>
              Other location…
            </Button>
            <span className="chooser-keys" aria-hidden="true">
              <kbd>↑↓</kbd> choose <kbd>→</kbd> inside <kbd>↵</kbd> open
            </span>
            {chosen?.kind === "skills" ? (
              <Button variant="primary" icon="library" onClick={() => act(chosen)}>
                Use as a library
              </Button>
            ) : (
              <Button variant="primary" disabled={!chosen} onClick={() => act(chosen)}>
                {chosen ? `Open ${chosen.name}` : "Open"}
              </Button>
            )}
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function haystack(e: FolderEntry): string {
  return [
    e.name,
    ...e.stacks,
    e.git?.branch ?? "",
    e.git?.remote ?? "",
    e.kind === "skills" ? "library skills" : "",
  ]
    .join(" ")
    .toLowerCase();
}

const rowId = (e: FolderEntry) => `folder-${e.path.replace(/[^A-Za-z0-9_-]/g, "_")}`;

function Row({
  entry,
  index,
  found,
  opened,
  selected,
  busiest,
  onSelect,
  onEnter,
  onInto,
}: {
  entry: FolderEntry;
  index: number;
  found: boolean;
  /** Already one of Habi's projects. */
  opened: boolean;
  selected: boolean;
  /** The busiest week in the list, to scale stitches by. */
  busiest: number;
  onSelect: () => void;
  /** Double click: open a project, look inside a folder. */
  onEnter: () => void;
  onInto: () => void;
}) {
  const parent = entry.display.slice(0, Math.max(0, entry.display.length - entry.name.length - 1));
  const detail = [entry.git?.branch, entry.git?.remote ?? (found ? parent : null)].filter(Boolean);
  const dormant = entry.git?.weeks.every((n) => n === 0);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the filter field handles the keys for the list.
    <div
      id={rowId(entry)}
      data-path={entry.path}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={`chooser-row is-${entry.kind}${dormant ? " is-dormant" : ""}${selected ? " is-selected" : ""}`}
      style={{ "--i": Math.min(index, 16), "--dye": dyeOf(entry) } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={onEnter}
    >
      <Thread kind={entry.kind} />
      <span className="chooser-what">
        <span className="chooser-line">
          <span className="chooser-name">{entry.name}</span>
          {entry.stacks.length > 0 ? (
            <span className="chooser-stacks">{entry.stacks.join(" · ")}</span>
          ) : null}
          {entry.kind === "skills" ? (
            <span className="chooser-library">{plural(entry.skills, "skill")}</span>
          ) : null}
          {entry.kind === "folder" && entry.inside > 0 ? (
            <span className="chooser-inside">{plural(entry.inside, "repo")}</span>
          ) : null}
          {entry.agents ? (
            <span
              className="chooser-agents"
              role="img"
              aria-label="has agent instructions"
              data-tip="Agent instructions — AGENTS.md, CLAUDE.md or an agent folder is already here"
            />
          ) : null}
          {opened ? <span className="chooser-opened">in Habi</span> : null}
        </span>
        {detail.length > 0 ? (
          <span className="chooser-detail">
            {entry.git?.branch ? <Icon name="branch" /> : null}
            {detail.join("  ·  ")}
          </span>
        ) : null}
      </span>
      {entry.git ? (
        <Stitches weeks={entry.git.weeks} busiest={busiest} />
      ) : (
        <span className="chooser-weave-empty" />
      )}
      <span className="chooser-when">{entry.modified ? relativeTime(entry.modified) : ""}</span>
      <button
        type="button"
        className="chooser-into icon-btn"
        aria-label={`Look inside ${entry.name}`}
        tabIndex={-1}
        onClick={(ev) => {
          ev.stopPropagation();
          onInto();
        }}
      >
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}

/** The row's own thread: a knot for a project, stitches for skills, a faint line for a folder. */
function Thread({ kind }: { kind: FolderEntry["kind"] }) {
  return (
    <svg
      className="chooser-thread"
      width="24"
      height="16"
      viewBox="0 0 24 16"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" y1="8" x2="24" y2="8" className="chooser-weft" />
      {kind === "project" ? <circle cx="12" cy="8" r="4" className="chooser-knot" /> : null}
      {kind === "skills" ? <line x1="12" y1="1" x2="12" y2="15" className="chooser-stitch" /> : null}
      {kind === "folder" ? <circle cx="12" cy="8" r="2.5" className="chooser-hollow" /> : null}
    </svg>
  );
}

/**
 * Twelve weeks of commits made on this machine, oldest on the left: each
 * week a stitch through the thread, as long as the week was busy compared
 * with the busiest week in the list. Pointing at a week says how many; at
 * the rest of the strip, how many in all.
 */
function Stitches({ weeks, busiest }: { weeks: number[]; busiest: number }) {
  const width = weeks.length * WEEK;
  const total = weeks.reduce((a, b) => a + b, 0);
  return (
    <svg
      className="chooser-stitches"
      width={width}
      height="22"
      viewBox={`0 0 ${width} 22`}
      aria-hidden="true"
      data-tip={`${plural(total, "commit")} — on this machine, last 12 weeks`}
    >
      <line x1="0" y1="11" x2={width} y2="11" className="chooser-stitches-weft" />
      {weeks.map((n, i) => {
        if (n === 0) return null;
        const h = 4 + 16 * Math.sqrt(n / busiest);
        const x = WEEK / 2 + i * WEEK;
        return (
          <g key={i} data-tip={`${plural(n, "commit")} — ${weekOf(weeks.length - 1 - i)}`}>
            <rect x={x - WEEK / 2} y="0" width={WEEK} height="22" className="chooser-stitches-hit" />
            <line x1={x} x2={x} y1={11 - h / 2} y2={11 + h / 2} className="chooser-stitches-week" />
          </g>
        );
      })}
    </svg>
  );
}

/** "this week", "last week", "week of Sep 14". */
function weekOf(weeksAgo: number): string {
  if (weeksAgo === 0) return "this week";
  if (weeksAgo === 1) return "last week";
  const start = new Date(Date.now() - (weeksAgo * 7 + 6) * 86_400_000);
  return `week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

const WEEK = 16;

/** A project's thread takes the dye of its main stack; a bare checkout stays ink. */
function dyeOf(e: FolderEntry): string {
  if (e.kind === "project") return stackDye(e.stacks[0] ?? "") ?? "var(--ink-muted)";
  if (e.kind === "skills") return "var(--ink-muted)";
  return "var(--hairline-strong)";
}

/** A folder of skills chosen with the native picker, where a project was expected. */
export function SkillsFolderCaught({
  pick,
  onLibrary,
  onOpenAnyway,
  onChooseAgain,
  onClose,
}: {
  pick: Extract<ProjectPick, { kind: "skills" }>;
  onLibrary: () => void;
  onOpenAnyway: () => void;
  onChooseAgain: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${pick.name} is a library`}
      description={`${plural(pick.skills, "skill")}, no code. Projects are what you build.`}
      footer={
        <>
          <Button variant="quiet" className="chooser-anyway" onClick={onOpenAnyway}>
            Open as a project anyway
          </Button>
          <Button onClick={onChooseAgain}>Choose another…</Button>
          <Button variant="primary" icon="library" onClick={onLibrary} autoFocus>
            Use as a library
          </Button>
        </>
      }
    >
      <p className="chooser-path mono">{pick.path}</p>
    </Dialog>
  );
}
