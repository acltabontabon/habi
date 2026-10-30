/**
 * Libraries: where knowledge comes from.
 *
 * - Your libraries: everything Habi keeps current for you, whatever its
 *   origin (your team's repository or folder, the community, the builders),
 *   one line each, what needs you first. A connected library is not yours: a
 *   copy you adopt and edit is.
 * - Explore: the catalog's public libraries not yet connected, filtered by
 *   who stands behind them. Grouping says who published a library, not
 *   whether it is safe: ownership is checked, content is not audited.
 * - Add a library: your own Git repository or folder, or one from the catalog.
 *
 * Opening a catalog library shows what is inside it (fetching it first, with
 * your say-so) before anything is connected. A connected library opens in
 * LibraryView.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogEntry } from "../../bindings/CatalogEntry";
import type { Source } from "../../bindings/Source";
import type { SourceVersion } from "../../bindings/SourceVersion";
import { BackLink } from "../../components/BackLink";
import { Icon } from "../../components/Icon";
import { Menu } from "../../components/Menu";
import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Notice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { WaitingLoom, Weaving } from "../../components/Weaving";
import { api, HabiError, newJobId } from "../../lib/api";
import { groupOfEntry } from "../../lib/catalog";
import { type Dye, useDyes } from "../../lib/dye";
import { compactCount, plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import {
  invalidateProjectData,
  useCatalog,
  useRecentProjects,
  useRepoFacts,
  useSkills,
  useSources,
  useSourceUpdates,
} from "../../lib/queries";
import { useOpenExternal } from "../../lib/safeInvoke";
import { ConnectLibrary } from "./ConnectLibrary";
import { LibraryView } from "./LibraryView";
import { repositoryLabel } from "./SourceSheet";

/**
 * The projects Habi suggests a catalog library's skills for, by name: from
 * each project's last look (nothing is inspected again to say it).
 */
function useFitsProjects(): (entryId: string) => { id: string; name: string }[] {
  const projects = useRecentProjects();
  return useMemo(() => {
    const list = (projects.data ?? []).filter((p) => p.exists);
    return (entryId: string) =>
      list.filter((p) => p.summary?.suggested.includes(entryId)).map((p) => ({ id: p.id, name: p.name }));
  }, [projects.data]);
}

/** "nextshop", "nextshop and api", "nextshop, api and 2 more". */
function projectNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** Connect your own library: one intent per page. */
function ConnectOwn({ mode, location }: { mode: "git" | "folder"; location?: string }) {
  const { navigate } = useNav();
  const toast = useToast();
  return (
    <div className="page connect-page">
      <header className="connect-head">
        <BackLink fallback={{ name: "sources" }} fallbackLabel="Your libraries" />
        <p className="kicker">Your own library</p>
        <h1 className="page-title">
          {mode === "git" ? "Connect a Git repository" : "Use a folder as a library"}
        </h1>
        <p className="lead-sm">
          {mode === "git"
            ? "A repository of Agent Skills your team keeps. Habi reads it, and you decide when it updates."
            : "Skill folders on this machine: a checkout, or your own collection."}
        </p>
      </header>
      <ConnectLibrary
        mode={mode}
        initialLocation={location}
        onCancel={() => navigate({ name: "sources" })}
        onConnected={(source, count) => {
          toast.show(`${source.name} connected: ${plural(count, "item")}.`);
          navigate({ name: "sources", sourceId: source.id });
        }}
      />
    </div>
  );
}

/* ---------- The way in: two knots on one thread ---------- */

/**
 * The whole idea of the page, as a thread with two knots. Each knot is lit
 * only when it is true of this machine: you have connected something, you
 * have adopted something.
 */
function PathSteps({ connected, adopted }: { connected: boolean; adopted: boolean }) {
  const steps = [
    {
      title: "Connect a library",
      text: "Bring your own, or pick one from the catalog. Habi reads it and keeps it current. Nothing is installed or run.",
      done: connected,
    },
    {
      title: "Put skills to work",
      text: "Add a skill to a project, or edit a copy and share it back.",
      done: adopted,
    },
  ];
  // The first step not yet true is where to start: it pulses, and points down at the list.
  const next = steps.findIndex((s) => !s.done);
  return (
    <ol className="path" aria-label="From connecting a library to using its skills">
      {steps.map((s, i) => (
        <li key={s.title} className={`path-step${s.done ? " is-done" : ""}${i === next ? " is-next" : ""}`}>
          <span className="path-knot" aria-hidden="true">
            {i + 1}
          </span>
          <span className="path-title">
            {s.title}
            {i === 0 && i === next ? (
              <span className="path-cue" aria-hidden="true">
                ↓
              </span>
            ) : null}
          </span>
          <span className="path-text">{s.text}</span>
          <span className="visually-hidden">{s.done ? " (you have)" : " (not yet)"}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Your libraries: one line each ---------- */

const PREVIEW_DYE: Dye = { color: "var(--ink-faint)", community: true };

/** What a library's row says when its repository has something newer. */
function newerText(v: SourceVersion): string {
  return v.release ? `${v.label} available` : "new commits available";
}

type Origin = "team" | "community" | "builders";

/** Who stands behind a connected library: the catalog's word, or how you connected it. */
function originOf(source: Source, entry: CatalogEntry | undefined): Origin {
  if (entry) return groupOfEntry(entry);
  return source.role === "community" ? "community" : "team";
}

function originLabel(source: Source, origin: Origin): string {
  if (origin === "builders") return "Builder";
  if (origin === "community") return "Community";
  return source.kind === "directory" ? "Your folder" : "Your team";
}

/**
 * Where a library stands, as one word or two, and how much it needs you:
 * a failed or offline library first, then one with something newer, then
 * one never read; a current library says nothing.
 */
function standing(
  source: Source,
  newer: SourceVersion | undefined,
): { text: string; tone: string; rank: number } {
  if (source.freshness === "fetchFailed") return { text: "fetch failed", tone: "danger", rank: 0 };
  if (source.freshness === "stale") return { text: "offline", tone: "warn", rank: 1 };
  if (newer) return { text: newerText(newer), tone: "thread", rank: 2 };
  if (source.freshness === "neverFetched") return { text: "not read yet", tone: "unknown", rank: 3 };
  return { text: "current", tone: "muted", rank: 9 };
}

const NEEDS_YOU = 3;

type Facet = "all" | "needs" | Origin;

/** A row of single-choice filters; one with nothing in it is not offered. */
function Facets<T extends string>({
  label,
  facets,
  value,
  onChange,
}: {
  label: string;
  facets: { id: T; label: string; count: number; tone?: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="mys-facets lib-facets">
      <legend className="visually-hidden">{label}</legend>
      {facets
        .filter((f, i) => i === 0 || f.count > 0 || f.id === value)
        .map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={value === f.id}
            className={
              `${value === f.id ? "is-on" : ""}${f.tone ? ` tone-${f.tone}` : ""}`.trim() || undefined
            }
            onClick={() => onChange(f.id)}
          >
            {f.label}
            <span className="mys-count">{f.count}</span>
          </button>
        ))}
    </fieldset>
  );
}

/** Bring in a library: your own repository or folder, or one from the catalog (unless it is open). */
function AddLibrary({ catalog = true }: { catalog?: boolean }) {
  const { navigate } = useNav();
  return (
    <Menu
      label="Add a library"
      className="lib-add"
      trigger={
        <>
          <Icon name="plus" /> Add a library
        </>
      }
      items={[
        [
          {
            label: "Git repository…",
            hint: "Your team's skills, from any Git host",
            icon: "branch",
            onSelect: () => navigate({ name: "sources", view: "git" }),
          },
          {
            label: "Folder…",
            hint: "Skills already on this machine",
            icon: "folder",
            onSelect: () => navigate({ name: "sources", view: "folder" }),
          },
        ],
        catalog
          ? [
              {
                label: "From the catalog",
                hint: "Public libraries by builders and the community",
                icon: "library",
                onSelect: () => navigate({ name: "sources", view: "explore" }),
              },
            ]
          : [],
      ]}
    />
  );
}

/** "/" focuses `input` from anywhere on the page that is not already a text field. */
function useSlashFocus(input: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable], [role=dialog]")
      )
        return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
}

/** Arrow keys and j/k move between `selector` rows; typing on a row filters. */
function rowKeys(
  box: React.RefObject<HTMLElement | null>,
  selector: string,
  filter: React.RefObject<HTMLInputElement | null>,
  type: (key: string) => void,
) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    const all = [...(box.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    const at = all.indexOf(t);
    if (at < 0) return;
    const move = (n: number) => {
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown" || e.key === "j") move(at + 1);
    else if (e.key === "ArrowUp" || e.key === "k") {
      if (at === 0) {
        e.preventDefault();
        filter.current?.focus();
      } else move(at - 1);
    } else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      type(e.key);
      filter.current?.focus();
    }
  };
}

function Filter({
  input,
  label,
  query,
  onQuery,
  onDown,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  label: string;
  query: string;
  onQuery: (q: string) => void;
  onDown: () => void;
}) {
  return (
    <div className="libraries-filter">
      <Icon name="search" size={12} />
      <label className="visually-hidden" htmlFor="libraries-filter">
        {label}
      </label>
      <input
        ref={input}
        id="libraries-filter"
        type="search"
        placeholder={label}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            onDown();
          } else if (e.key === "Escape" && query) {
            e.preventDefault();
            onQuery("");
          }
        }}
      />
      {!query ? (
        <span className="index-kbd" aria-hidden="true">
          /
        </span>
      ) : null}
    </div>
  );
}

/**
 * Your libraries: everything Habi keeps current for you, whatever its origin,
 * one line each so fifty read as easily as five. What needs you comes first;
 * what a library is about lives on its own page.
 */
function YourLibraries() {
  const catalog = useCatalog();
  const sources = useSources();
  const skills = useSkills();
  const dyes = useDyes();
  const { navigate } = useNav();
  const updates = useSourceUpdates();
  const newer = useMemo(
    () => new Map((updates.data ?? []).filter((u) => u.available).map((u) => [u.sourceId, u.latest])),
    [updates.data],
  );
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useSlashFocus(filter);

  const rows = useMemo(() => {
    const entries = new Map((catalog.data ?? []).filter((e) => e.sourceId).map((e) => [e.sourceId, e]));
    return (sources.data ?? [])
      .map((source) => {
        const entry = entries.get(source.id);
        const origin = originOf(source, entry);
        return { source, entry, origin, state: standing(source, newer.get(source.id)) };
      })
      .sort((a, b) => a.state.rank - b.state.rank || a.source.name.localeCompare(b.source.name));
  }, [catalog.data, sources.data, newer]);

  if (catalog.isPending || sources.isPending) return <Working>Loading libraries…</Working>;
  if (sources.isError) return <ErrorNotice error={sources.error} />;

  const adoptedAny = (skills.data ?? []).some((s) => s.origin.type === "library");
  const explore = (catalog.data ?? []).filter((e) => e.availability !== "connected").length;
  const q = query.trim().toLowerCase();
  const inFacet = (r: (typeof rows)[number], f: Facet) =>
    f === "all" || (f === "needs" ? r.state.rank <= NEEDS_YOU - 1 : r.origin === f);
  const count = (f: Facet) => rows.filter((r) => inFacet(r, f)).length;
  const shown = rows.filter(
    (r) =>
      inFacet(r, facet) &&
      (!q || `${r.source.name} ${r.source.location} ${r.entry?.repo ?? ""}`.toLowerCase().includes(q)),
  );

  return (
    <div className="page narrow libraries">
      <header className="libraries-head">
        <div>
          <p className="kicker">Libraries</p>
          <h1 className="page-title">
            Your libraries{rows.length > 0 ? <span className="lib-total">{rows.length}</span> : null}
          </h1>
        </div>
        <div className="libraries-bring">
          <Button icon="library" onClick={() => navigate({ name: "sources", view: "explore" })}>
            Explore{explore > 0 ? <span className="lib-explore-count">{explore}</span> : null}
          </Button>
          <AddLibrary />
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="lib-empty">
          <PathSteps connected={false} adopted={adoptedAny} />
          <p className="lead-sm">
            Libraries are where skills come from: your team's repository, a folder on this machine, or a
            public library from the catalog. Habi reads them and you decide when they update.
          </p>
          <div className="lib-empty-acts">
            <Button
              variant="primary"
              icon="library"
              onClick={() => navigate({ name: "sources", view: "explore" })}
            >
              Explore the catalog
            </Button>
            <Button icon="branch" onClick={() => navigate({ name: "sources", view: "git" })}>
              Connect a Git repository
            </Button>
            <Button icon="folder" onClick={() => navigate({ name: "sources", view: "folder" })}>
              Use a folder
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="lib-tools">
            <Filter
              input={filter}
              label="Filter your libraries"
              query={query}
              onQuery={setQuery}
              onDown={() => list.current?.querySelector<HTMLButtonElement>(".lib-row")?.focus()}
            />
            <Facets
              label="Show"
              value={facet}
              onChange={setFacet}
              facets={[
                { id: "all", label: "All", count: rows.length },
                { id: "needs", label: "Needs you", count: count("needs"), tone: "warn" },
                { id: "team", label: "Team", count: count("team") },
                { id: "community", label: "Community", count: count("community") },
                { id: "builders", label: "Builders", count: count("builders") },
              ]}
            />
          </div>
          {shown.length > 0 ? (
            <>
              <div className="lib-cols" aria-hidden="true">
                <span />
                <span>Library</span>
                <span>From</span>
                <span className="lib-num">Skills</span>
                <span>State</span>
              </div>
              <ol
                className="lib-ledger"
                ref={list}
                aria-label="Your libraries"
                onKeyDown={rowKeys(list, ".lib-row", filter, (k) => setQuery((cur) => cur + k))}
              >
                {shown.map(({ source, origin, entry, state }) => (
                  <li key={source.id}>
                    <button
                      type="button"
                      className="lib-row"
                      onClick={() => navigate({ name: "sources", sourceId: source.id })}
                      title={entry?.summary}
                    >
                      <Strand dye={dyes(source.id)} size={18} />
                      <span className="lib-name">
                        <span className="library-row-name">{source.name}</span>
                        <span className="library-row-repo">
                          {entry?.repo ?? repositoryLabel(source.location)}
                        </span>
                      </span>
                      <span className="lib-from">{originLabel(source, origin)}</span>
                      <span className="lib-num mono">{source.skillCount}</span>
                      <span className={`lib-state tone-${state.tone}`}>{state.text}</span>
                      <Icon name="chevronRight" size={14} className="lib-go" />
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <Empty title={q ? `No library matches “${query}”` : "Nothing here"}>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setQuery("");
                  setFacet("all");
                }}
              >
                Show all your libraries
              </button>
            </Empty>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Explore: the catalog, still to connect ---------- */

type Shelf = "all" | "builders" | "community";

/**
 * Public libraries not yet connected, as cards. Grouping says who published
 * a library, not whether it is safe: ownership is checked, content is not
 * audited, and a card says only what is known. Opening one shows what is
 * inside (fetching it first, with your say-so) before anything is connected.
 */
function Explore() {
  const catalog = useCatalog();
  const fitsProjects = useFitsProjects();
  const { navigate } = useNav();
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState<Shelf>("all");
  const filter = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  useSlashFocus(filter);

  if (catalog.isPending) return <Working>Loading the catalog…</Working>;
  if (catalog.isError) return <ErrorNotice error={catalog.error} />;

  // Libraries with something for your projects come first: that is why you would connect one.
  const open = catalog.data
    .filter((e) => e.availability !== "connected")
    .map((e, at) => ({ e, at, fits: fitsProjects(e.id).length }))
    .sort((a, b) => Number(b.fits > 0) - Number(a.fits > 0) || a.at - b.at)
    .map(({ e }) => e);
  const q = query.trim().toLowerCase();
  const matching = open.filter(
    (e) => !q || `${e.name} ${e.repo} ${e.summary} ${e.publisher.name}`.toLowerCase().includes(q),
  );
  const shown = matching.filter((e) => shelf === "all" || groupOfEntry(e) === shelf);

  return (
    <div className="page narrow libraries">
      <header className="libraries-head">
        <div>
          <BackLink fallback={{ name: "sources" }} fallbackLabel="Your libraries" />
          <p className="kicker">Libraries</p>
          <h1 className="page-title">Explore</h1>
          <p className="lead-sm">
            Public libraries to look inside before you connect one. Builders make the tools their skills are
            about; the community maintains the rest.
          </p>
        </div>
        <div className="libraries-bring">
          <AddLibrary catalog={false} />
        </div>
      </header>
      {open.length === 0 ? (
        <Empty title="Every catalog library is connected">
          Bring one of your own from a Git repository or a folder with Add a library.
        </Empty>
      ) : (
        <>
          <div className="lib-tools">
            <Filter
              input={filter}
              label="Filter libraries"
              query={query}
              onQuery={setQuery}
              onDown={() => grid.current?.querySelector<HTMLButtonElement>(".lib-card")?.focus()}
            />
            <Facets
              label="Show"
              value={shelf}
              onChange={setShelf}
              facets={[
                { id: "all", label: "All", count: matching.length },
                {
                  id: "builders",
                  label: "Builders",
                  count: matching.filter((e) => groupOfEntry(e) === "builders").length,
                },
                {
                  id: "community",
                  label: "Community",
                  count: matching.filter((e) => groupOfEntry(e) === "community").length,
                },
              ]}
            />
          </div>
          <ul
            className="lib-cards"
            ref={grid}
            aria-label="Libraries to explore"
            onKeyDown={rowKeys(grid, ".lib-card", filter, (k) => setQuery((cur) => cur + k))}
          >
            {shown.map((e) => (
              <ExploreCard
                key={e.id}
                entry={e}
                fits={fitsProjects(e.id).map((p) => p.name)}
                onOpen={() => navigate({ name: "sources", entry: e.id })}
              />
            ))}
          </ul>
          {shown.length === 0 ? (
            <Empty title={q ? `No library matches “${query}”` : "Nothing here"}>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setQuery("");
                  setShelf("all");
                }}
              >
                Show every library
              </button>
            </Empty>
          ) : null}
        </>
      )}
    </div>
  );
}

function ExploreCard({
  entry,
  fits,
  onOpen,
}: {
  entry: CatalogEntry;
  /** Your projects Habi suggests its skills for. */
  fits: string[];
  onOpen: () => void;
}) {
  const warn =
    entry.status.state !== "active"
      ? entry.status.state
      : entry.problem && entry.availability === "notFetched"
        ? "unreachable"
        : null;
  // How many people use it and whether it is alive: asked of GitHub only once they point at it.
  const [curious, setCurious] = useState(false);
  const facts = useRepoFacts(curious ? entry.id : undefined).data;
  return (
    <li>
      <button
        type="button"
        className="lib-card"
        onClick={onOpen}
        onPointerEnter={() => setCurious(true)}
        onFocus={() => setCurious(true)}
        title={entry.problem?.message ?? undefined}
      >
        <span className="lib-card-head">
          <span className="library-row-name">{entry.name}</span>
          <Icon name="chevronRight" size={14} className="lib-go" />
        </span>
        <span className="library-row-repo">{entry.repo}</span>
        <span className="lib-card-summary">{entry.summary}</span>
        {fits.length > 0 ? <span className="lib-card-fits">For {projectNames(fits)}</span> : null}
        <span className="lib-card-foot">
          {groupOfEntry(entry) === "builders" ? "Builder" : "Community"}
          {facts ? ` · ${compactCount(facts.stars)} stars` : ""}
          {warn ? <span className="tone-warn"> · {warn}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * A library's page before it is connected: what the catalog knows (nothing is
 * fetched to show it) and one button. Pressing Connect reads the repository
 * (newest commit only) while the loom weaves, then opens the connected
 * library. Connecting installs, copies and runs nothing, and one that is
 * cancelled or fails leaves nothing behind.
 */
function LibraryPage({ entryId }: { entryId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const openExternal = useOpenExternal();
  const { navigate } = useNav();
  const catalog = useCatalog();
  const entry = catalog.data?.find((e) => e.id === entryId);
  const fitsProjects = useFitsProjects()(entryId);
  // Context from GitHub, when it can be had: never an error, and not needed to connect.
  const facts = useRepoFacts(entry && entry.availability !== "connected" ? entry.id : undefined).data;
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  const jobRef = useRef<string | null>(null);

  const connectIt = async () => {
    const id = newJobId();
    setJob(id);
    jobRef.current = id;
    setError(null);
    try {
      const source = await api.connectCatalogEntry(entryId, id);
      invalidateProjectData(client);
      toast.show(`${source.name} connected. Nothing was installed.`);
      // This page only passes through: Back should not land on it again.
      if (mounted.current) navigate({ name: "sources", sourceId: source.id }, { replace: true });
    } catch (e) {
      invalidateProjectData(client);
      if (mounted.current) setError(e);
    } finally {
      jobRef.current = null;
      if (mounted.current) setJob(null);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (jobRef.current) void api.cancelJob(jobRef.current);
    };
  }, []);

  // A library that is already connected has no page of this kind: go to it.
  const connectedAs = entry?.availability === "connected" ? entry.sourceId : null;
  useEffect(() => {
    if (connectedAs) navigate({ name: "sources", sourceId: connectedAs }, { replace: true });
  }, [connectedAs, navigate]);

  if (catalog.isPending) return <Working>Loading libraries…</Working>;
  if (catalog.isError) return <ErrorNotice error={catalog.error} />;
  if (!entry) return <Explore />;

  const cancelled = error instanceof HabiError && error.code === "cancelled";
  const idle = !job && !error;
  const fits = entry.fitsWhen;
  // An ownership that GitHub does not vouch for is worth saying plainly; a verified one rides on the kicker.
  const notes =
    entry.ownership && entry.ownership.method !== "github-verified-org"
      ? [`${entry.ownership.evidence}.`, ...entry.notes]
      : entry.notes;
  // Notes take whatever the other columns leave of the four.
  const notesSpan = fits.length > 0 ? 2 : 3;

  return (
    <div className="page narrow preview-page library-page">
      <BackLink fallback={{ name: "sources", view: "explore" }} fallbackLabel="Explore" />

      {/* One aligned dossier on four columns: who it is and the way in, how much it is used,
          how it was checked, and the loom along the foot. */}
      <header className="lp-head">
        <div className="lp-title">
          <p
            className="kicker"
            title={
              entry.ownership
                ? `${entry.ownership.evidence} (checked ${entry.ownership.checked}).`
                : undefined
            }
          >
            {entry.publisher.kind === "builder" ? "From the builders" : "From the community"}
          </p>
          <h1 className="page-title">
            <Strand dye={PREVIEW_DYE} size={22} /> {entry.name}
          </h1>
          <button
            type="button"
            className="lp-repo mono"
            onClick={() => openExternal(entry.url)}
            title={`Open ${entry.url} in your browser`}
          >
            {entry.repo}
            <Icon name="external" size={12} />
          </button>
        </div>
        {idle ? (
          <Button variant="primary" icon="download" onClick={() => void connectIt()}>
            Connect library
          </Button>
        ) : null}
      </header>
      <p className="lp-gist">{entry.summary}</p>

      {entry.picks.length > 0 ? (
        <section className="lp-picks" aria-labelledby="lp-picks">
          <h2 id="lp-picks" className="kicker">
            Habi's picks
            {fitsProjects.length > 0 ? (
              <span className="lp-picks-for">
                {" "}
                · suggested for{" "}
                {fitsProjects.map((p, i) => (
                  <Fragment key={p.id}>
                    {i > 0 ? (i === fitsProjects.length - 1 ? " and " : ", ") : null}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => navigate({ name: "project", projectId: p.id, tab: "suggested" })}
                    >
                      {p.name}
                    </button>
                  </Fragment>
                ))}
              </span>
            ) : null}
          </h2>
          <ul className="lp-pick-list">
            {entry.picks.map((p) => (
              <li key={p.skill} className="lp-pick">
                <span className="lp-pick-title">{p.title}</span>
                <span className="lp-pick-gist">{p.gist}</span>
                <span className="lp-pick-why">{p.why}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {entry.status.state !== "active" ? (
        <Notice tone="warn" title={entry.status.state === "archived" ? "Archived" : "Deprecated"}>
          {entry.status.note ?? "The publisher no longer maintains it."}
        </Notice>
      ) : null}
      {facts?.archived ? (
        <Notice tone="warn" title="Archived on GitHub">
          Its owner no longer maintains it.
        </Notice>
      ) : null}

      {facts ? (
        <dl
          className="lp-figures"
          aria-label={`${entry.name} on GitHub`}
          title={`From GitHub, ${relativeTime(facts.fetchedAt)}`}
        >
          <div>
            <dd>{compactCount(facts.stars)}</dd>
            <dt>stars</dt>
          </div>
          <div>
            <dd>{compactCount(facts.forks)}</dd>
            <dt>forks</dt>
          </div>
          <div>
            <dd>{facts.pushedAt ? relativeTime(facts.pushedAt) : "—"}</dd>
            <dt>last pushed</dt>
          </div>
          <div>
            <dd>{facts.createdYear ?? "—"}</dd>
            <dt>since</dt>
          </div>
        </dl>
      ) : null}

      <div className="lp-checks">
        {fits.length > 0 ? (
          <section>
            <h2 className="kicker">Fits projects with</h2>
            <ul className="lp-plain">
              {fits.slice(0, FITS_SHOWN).map((t) => (
                <li key={`${t.kind}:${t.text}`} className={t.kind === "tag" ? undefined : "mono"}>
                  {t.text}
                </li>
              ))}
            </ul>
            {fits.length > FITS_SHOWN ? <p className="lp-sub">and {fits.length - FITS_SHOWN} more</p> : null}
          </section>
        ) : null}
        <section>
          <h2 className="kicker">Habi reads</h2>
          <p className="lp-sub">{entry.followsReleases ? "The latest release" : "The default branch"}</p>
          <ul className="lp-plain">
            {entry.include.map((g) => (
              <li key={g} className="mono">
                {g}
              </li>
            ))}
          </ul>
          {entry.exclude.length > 0 ? <p className="lp-sub">Skips {entry.exclude.join(", ")}</p> : null}
        </section>
        {/* Only when Habi's catalog records an inspection: "not reviewed" is the default, not news. */}
        {entry.review ? (
          <section>
            <h2 className="kicker">Reviewed</h2>
            <p>{entry.review.scope}</p>
            <p className="lp-sub">
              {entry.review.by}, {entry.review.date}
            </p>
          </section>
        ) : null}
        {notes.length > 0 ? (
          <section className="lp-notes" style={{ "--span": notesSpan } as CSSProperties}>
            <h2 className="kicker">Notes</h2>
            <ul>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* The loom is where connecting happens: waiting, weaving, stopped or failed. */}
      <div className="lp-loom">
        {idle ? <WaitingLoom wide /> : null}
        {job ? (
          <Weaving
            wide
            label={`Connecting ${entry.repo}… nothing is installed or run.`}
            hint="A large repository takes a minute the first time. It is kept, so it is instant afterwards."
            onCancel={() => void api.cancelJob(job)}
          />
        ) : null}
        {cancelled ? (
          <Weaving wide stopped="cancelled" label="You stopped the weaving. Nothing was kept.">
            <Button variant="primary" onClick={() => void connectIt()}>
              Connect
            </Button>
          </Weaving>
        ) : null}
        {error && !cancelled ? (
          <>
            <Weaving wide stopped="failed" label="The thread snapped before the library could be connected.">
              <Button variant="primary" onClick={() => void connectIt()}>
                Try again
              </Button>
            </Weaving>
            <ErrorNotice error={error} title="Could not connect" />
          </>
        ) : null}
      </div>
    </div>
  );
}

const FITS_SHOWN = 6;

export function SourcesView({
  sourceId,
  entry,
  view,
  location,
  itemId,
  file,
}: {
  sourceId?: string;
  entry?: string;
  view?: "git" | "folder" | "explore";
  location?: string;
  itemId?: string;
  file?: string;
}) {
  const sources = useSources();
  if (view === "explore") return <Explore />;
  if (view) return <ConnectOwn key={location} mode={view} location={location} />;
  if (entry) return <LibraryPage key={entry} entryId={entry} />;
  const source = sources.data?.find((s) => s.id === sourceId);
  if (source) return <LibraryView key={source.id} source={source} itemId={itemId} file={file} />;
  return <YourLibraries />;
}
