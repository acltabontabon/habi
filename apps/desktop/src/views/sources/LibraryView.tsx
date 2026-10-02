/**
 * A library: what knowledge exists here.
 *
 * Two areas. On the left, the library's identity in a few lines and its
 * skills as a scannable index (search, ↑/↓ or j/k). On the right, one
 * reading surface: the chosen skill — what it does, the one thing to do
 * with it, a line of facts — then its documentation, with the package
 * beside it. Opening a file replaces the surface; ← or Esc comes back.
 * Where the knowledge comes from (repository, revision, refresh) is a
 * sheet opened from the library's address.
 */
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Source } from "../../bindings/Source";
import { Button, Empty, ErrorNotice, Working } from "../../components/ui";
import { Selvedge } from "../../components/Weave";
import { useActions } from "../../lib/actions";
import { useDyes } from "../../lib/dye";
import { freshnessText, kindLabel, plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { useLibrary, useRefreshSource } from "../../lib/queries";
import { codeFiles, describeCondition, licenseText, lineageParts } from "../../lib/skillFacts";
import { SkillReader } from "../reader/SkillReader";
import { AddToProjectDialog } from "./AddToProjectDialog";
import { repositoryLabel, SourceSheet } from "./SourceSheet";

function IndexRow({
  item,
  active,
  onSelect,
  onKeyDown,
}: {
  item: LibraryItem;
  active: boolean;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const code = codeFiles(item);
  const marks = [
    item.requirement === "required" ? "required" : null,
    item.metadataStatus === "declared" ? "rules" : null,
    code > 0 ? `${code} ${code === 1 ? "script" : "scripts"}` : null,
    item.kind !== "skill" ? kindLabel[item.kind].toLowerCase() : null,
  ].filter(Boolean);
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
        <span className="index-row-title">{item.title}</span>
        {marks.length > 0 ? <span className="index-row-marks">{marks.join(" · ")}</span> : null}
        <span className="index-row-desc">{item.description}</span>
      </button>
    </li>
  );
}

/** What the skill is and what to do with it; above its documentation. */
function SkillIntro({ item, source }: { item: LibraryItem; source: Source }) {
  const { addSkills } = useActions();
  const [adding, setAdding] = useState(false);
  const code = codeFiles(item);
  const folders = new Set(item.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  folders.delete("");
  const lineage = item.basedOn ? lineageParts(item.basedOn) : null;
  return (
    <header className="skill-intro">
      <p className="kicker">
        {kindLabel[item.kind]} · {source.name}
      </p>
      <h2 className="skill-title">{item.title}</h2>
      <p className="skill-purpose">{item.description}</p>
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
      <dl className="skill-facts">
        <dt>Applies</dt>
        <dd>
          {item.appliesWhen
            ? `when ${describeCondition(item.appliesWhen)}${item.excludes ? `, unless ${describeCondition(item.excludes)}` : ""}`
            : "no rules — use it deliberately; Habi does not recommend it on its own"}
        </dd>
        <dt>Package</dt>
        <dd>
          {plural(item.files.length, "file")}
          {folders.size > 0 ? ` · ${[...folders].sort().join(", ")}` : ""}
        </dd>
        {code > 0 ? (
          <>
            <dt>Runs</dt>
            <dd className="fact-runs">
              {plural(code, "script")} an agent may execute
              {source.role === "community" ? " · read before use" : ""}
            </dd>
          </>
        ) : null}
        <dt>Source</dt>
        <dd>
          {source.role === "community" ? "community · not team-reviewed" : "team library"}
          {lineage ? (
            <span className="mono" title={item.basedOn ?? undefined}>
              {" "}
              · based on {lineage.library.split("/").slice(-1)[0]}/{lineage.item}
            </span>
          ) : null}
        </dd>
        <dt>Licence</dt>
        <dd className={item.licenseRestricted ? "fact-runs" : undefined}>
          {licenseText(item.license, item.licenseFile)}
        </dd>
      </dl>
      {adding ? <AddToProjectDialog item={item} onClose={() => setAdding(false)} /> : null}
    </header>
  );
}

export function LibraryView({ source, itemId, file }: { source: Source; itemId?: string; file?: string }) {
  const { navigate } = useNav();
  const library = useLibrary(source.id, Boolean(source.snapshot));
  const refresh = useRefreshSource();
  const dye = useDyes()(source.id);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const fresh = freshnessText(source);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (library.data?.items ?? []).filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.id.includes(q),
    );
  }, [library.data, query]);
  const selected = library.data?.items.find((i) => i.id === itemId) ?? items[0] ?? null;
  const all = library.data?.items ?? [];
  const scripted = all.filter((i) => codeFiles(i) > 0).length;

  const open = (item: LibraryItem) => navigate({ name: "sources", sourceId: source.id, itemId: item.id });
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) return;
    e.preventDefault();
    const index = items.findIndex((i) => i.id === selected?.id);
    const next =
      items[
        Math.max(0, Math.min(items.length - 1, index + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1)))
      ];
    if (!next) return;
    open(next);
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(next.id)}"]`)?.focus(),
    );
  };

  return (
    <div className="library">
      <Selvedge dye={dye} />
      <aside className="library-index">
        <header className="library-id">
          <p className="kicker">{source.role === "community" ? "Community library" : "Team library"}</p>
          <h1 className="library-name">{library.data?.name ?? source.name}</h1>
          <button
            type="button"
            className="library-repo"
            onClick={() => setSheet(true)}
            title="Where it comes from"
          >
            {repositoryLabel(source.location)}
            {source.subdir ? ` › ${source.subdir}` : ""}
          </button>
          <p className="library-facts">
            {source.snapshot ? (
              <>
                {plural(all.length, "skill")}
                {scripted > 0 ? ` · ${scripted} with scripts` : ""} ·{" "}
                <span
                  className={fresh.tone === "muted" || fresh.tone === "ok" ? undefined : `tone-${fresh.tone}`}
                >
                  {source.freshness === "current" && source.snapshotAt
                    ? `updated ${relativeTime(source.snapshotAt)}`
                    : fresh.text}
                </span>
              </>
            ) : (
              "not fetched yet"
            )}
          </p>
          {source.role === "community" ? <p className="library-trust">not reviewed by your team</p> : null}
          {library.data?.description ? <p className="library-about">{library.data.description}</p> : null}
        </header>
        {source.snapshot && all.length > 0 ? (
          <div className="list-filter">
            <label className="visually-hidden" htmlFor="lib-filter">
              Search this library
            </label>
            <input
              id="lib-filter"
              type="search"
              placeholder={`Search ${plural(all.length, "skill")}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}
        {library.isPending && source.snapshot ? <Working>Reading the library…</Working> : null}
        {library.isError ? <ErrorNotice error={library.error} /> : null}
        <ul className="index-list" ref={listRef}>
          {items.map((i) => (
            <IndexRow
              key={i.id}
              item={i}
              active={i.id === selected?.id}
              onSelect={() => open(i)}
              onKeyDown={onKeyDown}
            />
          ))}
        </ul>
        {library.data && items.length === 0 && query ? (
          <p className="index-empty muted">Nothing matches.</p>
        ) : null}
      </aside>

      <main className="library-reader">
        {!source.snapshot ? (
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
            intro={<SkillIntro item={selected} source={source} />}
          />
        ) : library.data ? (
          <Empty title="This library has no skills yet" />
        ) : null}
      </main>
      {sheet ? <SourceSheet source={source} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
