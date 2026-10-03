/**
 * Libraries: where knowledge comes from, grouped by who stands behind it.
 *
 * - Connected: what Habi keeps current for you, wherever it came from. A
 *   connected library is not yours: a copy you adopt and edit is.
 * - Bring your own: connect a repository or folder of your own.
 * - From the builders: the organisations behind the tools the skills are about.
 * - From the community: independent maintainers.
 *
 * Grouping says who published a library, not whether it is safe: ownership is
 * checked, content is not audited, and each row says only what is known. A
 * library is one row whether or not it is connected; opening one shows what
 * is inside it (fetching it first, with your say-so) before anything is
 * connected. A connected library opens in LibraryView.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry } from "../../bindings/CatalogEntry";
import type { Source } from "../../bindings/Source";
import type { SourceVersion } from "../../bindings/SourceVersion";
import { BackLink } from "../../components/BackLink";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { tip } from "../../components/Tooltips";
import { Button, Empty, ErrorNotice, Notice, Working } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { WaitingLoom, Weaving } from "../../components/Weaving";
import { api, HabiError, newJobId } from "../../lib/api";
import { groupOfEntry } from "../../lib/catalog";
import { type Dye, useDyes } from "../../lib/dye";
import { compactCount, freshnessText, plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import {
  invalidateProjectData,
  useCatalog,
  useRepoFacts,
  useSkills,
  useSources,
  useSourceUpdates,
} from "../../lib/queries";
import { useOpenExternal } from "../../lib/safeInvoke";
import { ConnectLibrary } from "./ConnectLibrary";
import { LibraryView } from "./LibraryView";
import { repositoryLabel } from "./SourceSheet";

/** Connect your own library: one intent per page. */
function ConnectOwn({ mode, location }: { mode: "git" | "folder"; location?: string }) {
  const { navigate } = useNav();
  const toast = useToast();
  return (
    <div className="page connect-page">
      <header className="connect-head">
        <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />
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
      text: "Pick any library below. Habi reads it and keeps it current. Nothing is installed or run.",
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

/* ---------- The ledger ---------- */

const PREVIEW_DYE: Dye = { color: "var(--ink-faint)", community: true };

/**
 * One library, self-contained so it reads at any column width: who it is,
 * a gist of what it is, and at the right what is known (counts once read).
 * A row speaks only when it differs from its group: a deprecated or
 * unreachable library says so; how an owner was checked is in the library's
 * own masthead.
 */
/** What a library's row says when its repository has something newer. */
function newerText(v: SourceVersion): string {
  return v.release ? `${v.label} available` : "new commits available";
}

function EntryRow({
  entry,
  source,
  dye,
  newer,
  onOpen,
}: {
  entry: CatalogEntry;
  source: Source | undefined;
  dye: Dye;
  /** The version the repository has now, when it is not the one read. */
  newer?: SourceVersion;
  onOpen: () => void;
}) {
  const warn =
    entry.status.state !== "active"
      ? entry.status.state === "archived"
        ? "archived"
        : "deprecated"
      : entry.problem && entry.availability === "notFetched"
        ? "unreachable"
        : null;
  const fresh = source ? freshnessText(source) : null;
  // What a person weighing a library wants to know: how many people use it
  // and whether it is alive. Asked of GitHub only once they point at the row.
  const [curious, setCurious] = useState(false);
  const facts = useRepoFacts(curious ? entry.id : undefined).data;
  const problem: { text: string; tone: string } | null = warn
    ? { text: warn, tone: "warn" }
    : fresh && entry.availability === "connected" && fresh.tone !== "muted" && fresh.tone !== "ok"
      ? { text: fresh.text, tone: fresh.tone }
      : newer && entry.availability === "connected"
        ? { text: newerText(newer), tone: "thread" }
        : null;
  return (
    <li>
      <button
        type="button"
        className={`library-row is-entry${entry.availability === "connected" ? " is-connected" : ""}`}
        onClick={onOpen}
        onPointerEnter={() => setCurious(true)}
        onFocus={() => setCurious(true)}
        title={entry.problem?.message ?? undefined}
        {...(facts && !entry.problem
          ? tip({
              title: `${compactCount(facts.stars)} stars`,
              lines: [
                {
                  text: [
                    facts.pushedAt ? `updated ${relativeTime(facts.pushedAt)}` : null,
                    facts.createdYear ? `since ${facts.createdYear}` : null,
                    `${compactCount(facts.forks)} forks`,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                },
              ],
              note: facts.archived ? { text: "Archived — no longer maintained", tone: "warn" } : undefined,
            })
          : {})}
      >
        <Strand dye={dye} size={18} />
        <span className="lr-main">
          <span className="lr-head">
            <span className="library-row-name">{entry.name}</span>
            <span className="library-row-repo">{entry.repo}</span>
            <span className="lr-go" aria-hidden="true">
              →
            </span>
          </span>
          <span className="library-row-summary">{entry.summary}</span>
          {/* Counts, licence and age live in the library's own header. A row only
              speaks up when something is wrong. */}
          {problem ? <span className={`lr-facts tone-${problem.tone}`}>{problem.text}</span> : null}
        </span>
      </button>
    </li>
  );
}

function OwnRow({
  source,
  dye,
  newer,
  onOpen,
}: {
  source: Source;
  dye: Dye;
  newer?: SourceVersion;
  onOpen: () => void;
}) {
  const fresh = freshnessText(source);
  const local =
    source.kind === "directory" || source.location.startsWith("/") || source.location.startsWith("~");
  const kind = source.role === "community" ? "community" : local ? "local" : "team";
  return (
    <li>
      <button type="button" className="library-row is-entry is-connected" onClick={onOpen}>
        <Strand dye={dye} size={18} />
        <span className="lr-main">
          <span className="lr-head">
            <span className="library-row-name">{source.name}</span>
            {source.sample ? <span className="sidebar-tag">sample</span> : null}
            <span className="library-row-repo">{repositoryLabel(source.location)}</span>
            <span className="lr-go" aria-hidden="true">
              →
            </span>
          </span>
          <span className="library-row-summary">
            {kind} · {source.kind === "directory" ? "folder" : "git"}
          </span>
          {fresh.tone !== "muted" && fresh.tone !== "ok" ? (
            <span className={`lr-facts tone-${fresh.tone}`}>{fresh.text}</span>
          ) : newer ? (
            <span className="lr-facts tone-thread">{newerText(newer)}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Group({
  id,
  area,
  title,
  note,
  count,
  children,
}: {
  id: string;
  /** Where the group sits when the page has room for columns. */
  area: "connected" | "builders" | "community";
  title: string;
  note?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className={`libraries-section area-${area}`} aria-labelledby={id}>
      <div className="libraries-section-head">
        <h2 id={id} className="kicker">
          {title}
          {count !== undefined ? <span className="kicker-count">{count}</span> : null}
        </h2>
        {note ? <span className="libraries-note">{note}</span> : null}
      </div>
      <ul className="library-rows">{children}</ul>
    </section>
  );
}

function LibrariesOverview() {
  const catalog = useCatalog();
  const sources = useSources();
  const dyes = useDyes();
  const { navigate } = useNav();
  // Libraries whose repository has something newer than what they read.
  const updates = useSourceUpdates();
  const newer = useMemo(
    () => new Map((updates.data ?? []).filter((u) => u.available).map((u) => [u.sourceId, u.latest])),
    [updates.data],
  );
  const [query, setQuery] = useState("");
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const skills = useSkills();
  const adoptedAny = (skills.data ?? []).some((s) => s.origin.type === "library");
  const connected = sources.data;
  const q = query.trim().toLowerCase();
  // Connected is everything Habi keeps current, whether it came from the catalog or from
  // you; the groups below are what is still to explore.
  const mine = useMemo(() => {
    if (!connected) return [];
    return [...connected]
      .filter((s) => !q || `${s.name} ${s.location}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connected, q]);

  // "/" finds a library from anywhere on the page.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable], [role=dialog]")
      )
        return;
      e.preventDefault();
      filter.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (catalog.isPending || sources.isPending) return <Working>Loading libraries…</Working>;
  if (catalog.isError) return <ErrorNotice error={catalog.error} />;
  if (sources.isError) return <ErrorNotice error={sources.error} />;

  const sourceById = new Map(sources.data.map((s) => [s.id, s]));
  const visible = catalog.data.filter(
    (e) => !q || `${e.name} ${e.repo} ${e.summary} ${e.publisher.name}`.toLowerCase().includes(q),
  );
  const toExplore = visible.filter((e) => e.availability !== "connected");
  const builders = toExplore.filter((e) => groupOfEntry(e) === "builders");
  const community = toExplore.filter((e) => groupOfEntry(e) === "community");
  const entryOf = new Map(catalog.data.filter((e) => e.sourceId).map((e) => [e.sourceId, e]));

  const openEntry = (e: CatalogEntry) =>
    navigate(
      e.availability === "connected" && e.sourceId
        ? { name: "sources", sourceId: e.sourceId }
        : { name: "sources", entry: e.id },
    );
  const row = (e: CatalogEntry) => {
    const source = e.sourceId ? sourceById.get(e.sourceId) : undefined;
    return (
      <EntryRow
        key={e.id}
        entry={e}
        source={source}
        dye={source ? dyes(source.id) : PREVIEW_DYE}
        newer={source ? newer.get(source.id) : undefined}
        onOpen={() => openEntry(e)}
      />
    );
  };

  // Arrow keys and j/k move through every row, group to group.
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button.library-row") ?? [])];
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      rows()[0]?.focus();
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("library-row")) return;
    const all = rows();
    const at = all.indexOf(t as HTMLButtonElement);
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
      // Typing on a row filters, like the index of a library.
      e.preventDefault();
      setQuery((cur) => cur + e.key);
      filter.current?.focus();
    }
  };

  return (
    <div className="page narrow libraries">
      <header className="libraries-head">
        <p className="kicker">Libraries</p>
        <h1 className="page-title">Where your knowledge comes from</h1>
        {/* Your own library, one glance away on every visit. */}
        <div className="libraries-bring">
          <Button icon="branch" onClick={() => navigate({ name: "sources", view: "git" })}>
            Connect a Git repository
          </Button>
          <Button icon="folder" onClick={() => navigate({ name: "sources", view: "folder" })}>
            Use a folder
          </Button>
        </div>
        {/* The way it works, only until something is connected. */}
        {sources.data.length === 0 ? <PathSteps connected={false} adopted={adoptedAny} /> : null}
        <div className="libraries-filter">
          <Icon name="search" size={12} />
          <label className="visually-hidden" htmlFor="libraries-filter">
            Filter libraries
          </label>
          <input
            ref={filter}
            id="libraries-filter"
            type="search"
            placeholder="Filter libraries"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFilterKey}
          />
          {!query ? (
            <span className="index-kbd" aria-hidden="true">
              /
            </span>
          ) : null}
        </div>
      </header>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow-key movement between the rows' own buttons */}
      <div
        className={`libraries-groups is-${[mine.length, builders.length, community.length].filter((n) => n > 0).length}`}
        ref={list}
        onKeyDown={onKeyDown}
      >
        {mine.length === 0 ? null : (
          <Group
            id="lib-connected"
            area="connected"
            title="Connected"
            count={mine.length}
            note="you choose when they update"
          >
            {mine.map((s) => {
              const entry = entryOf.get(s.id);
              return entry ? (
                <EntryRow
                  key={s.id}
                  entry={entry}
                  source={s}
                  dye={dyes(s.id)}
                  newer={newer.get(s.id)}
                  onOpen={() => openEntry(entry)}
                />
              ) : (
                <OwnRow
                  key={s.id}
                  source={s}
                  dye={dyes(s.id)}
                  newer={newer.get(s.id)}
                  onOpen={() => navigate({ name: "sources", sourceId: s.id })}
                />
              );
            })}
          </Group>
        )}

        {builders.length > 0 ? (
          <Group id="lib-builders" area="builders" title="From the builders" count={builders.length} note="">
            {builders.map(row)}
          </Group>
        ) : null}

        {community.length > 0 ? (
          <Group
            id="lib-community"
            area="community"
            title="From the community"
            count={community.length}
            note="independent maintainers"
          >
            {community.map(row)}
          </Group>
        ) : null}

        {q && builders.length + community.length + mine.length === 0 ? (
          <Empty title={`No library matches “${query}”`}>
            Clear the filter to see them all, or connect one of your own below.
          </Empty>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- A catalog library: its page, then connecting it ---------- */

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
  if (!entry) return <LibrariesOverview />;

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
      <BackLink fallback={{ name: "sources" }} fallbackLabel="Libraries" />

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
  view?: "git" | "folder";
  location?: string;
  itemId?: string;
  file?: string;
}) {
  const sources = useSources();
  if (view) return <ConnectOwn key={location} mode={view} location={location} />;
  if (entry) return <LibraryPage key={entry} entryId={entry} />;
  const source = sources.data?.find((s) => s.id === sourceId);
  if (source) return <LibraryView key={source.id} source={source} itemId={itemId} file={file} />;
  return <LibrariesOverview />;
}
