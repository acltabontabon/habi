/** Team knowledge: connected libraries, their freshness, and what they contain. */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Condition } from "../../bindings/Condition";
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Source } from "../../bindings/Source";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Label, Notice, Section, Status, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api, HabiError } from "../../lib/api";
import { freshnessText, kindLabel, NO_RULES_PHRASE, plural, relativeTime, shortId } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, useLibrary, useRefreshSource, useSources } from "../../lib/queries";
import { tagLabel } from "../../lib/tags";
import { ContentPanel } from "../project/ContentPanel";
import { ConnectLibrary } from "./ConnectLibrary";

export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "all":
      return c.items.map(describeCondition).join(" and ");
    case "any":
      return `(${c.items.map(describeCondition).join(" or ")})`;
    case "not":
      return `not ${describeCondition(c.item)}`;
    case "dependency":
      return `depends on ${c.name}${c.version ? ` ${c.version}` : ""}`;
    case "file":
      return `has files matching ${c.glob}`;
    case "tag":
      return tagLabel(c.tag);
  }
}

function AddSource() {
  const { navigate } = useNav();
  const toast = useToast();
  return (
    <div className="page narrow connect-page">
      <h1 className="page-title">Connect a team library</h1>
      <p className="lead-sm">
        A Git repository of skills your team maintains. Its skills are matched to your projects, and stay
        current when you refresh.
      </p>
      <ConnectLibrary
        onCancel={() => navigate({ name: "sources" })}
        onConnected={(source, count) => {
          toast.show(`${source.name} connected: ${plural(count, "item")} available.`);
          navigate({ name: "sources", sourceId: source.id });
        }}
      />
      <details className="advanced connect-help">
        <summary>What Habi reads and changes</summary>
        <div className="advanced-body prose-sm">
          <p>
            Habi fetches the repository into its own cache with the Git setup you already use — your
            credential helper or SSH agent. It never asks for or stores passwords, and it does not run
            anything from the library.
          </p>
          <p>
            Refreshing only updates the catalog. Skills installed in your projects change only when you review
            and accept an update.
          </p>
          <p>Do not paste tokens into the URL; Habi refuses URLs that contain credentials.</p>
        </div>
      </details>
    </div>
  );
}

function ItemRow({ item, active, onSelect }: { item: LibraryItem; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`rec-row${active ? " is-active" : ""}`}
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="rec-row-top">
          <span className="rec-row-title">{item.title}</span>
          {item.requirement === "required" ? <Label tone="thread">required</Label> : null}
          {item.metadataStatus === "invalid" ? <Status tone="warn">metadata invalid</Status> : null}
        </span>
        <span className="rec-row-reason">{item.description}</span>
        <span className="rec-row-meta">
          {kindLabel[item.kind]}
          {item.owner ? ` · ${item.owner}` : ""}
        </span>
      </button>
    </li>
  );
}

function SourceDetail({ source, itemId }: { source: Source; itemId?: string }) {
  const { navigate } = useNav();
  const { addSkills } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const library = useLibrary(source.id, Boolean(source.snapshot));
  const refresh = useRefreshSource();
  const [query, setQuery] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
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
  const selected = library.data?.items.find((i) => i.id === itemId) ?? null;

  const doRefresh = () =>
    refresh.mutate(source.id, {
      onSuccess: (r) =>
        toast.show(
          r.changed
            ? `${source.name}: ${r.updated.length} updated, ${r.added.length} new, ${r.removed.length} removed. Installed copies were not changed.`
            : `${source.name} is up to date.`,
        ),
    });

  const remove = async () => {
    try {
      await api.removeSource(source.id);
    } catch (e) {
      toast.show(
        `Could not disconnect ${source.name}: ${e instanceof Error ? e.message : String(e)}`,
        "danger",
      );
      return;
    }
    invalidateProjectData(client);
    toast.show(`${source.name} disconnected. Installed content in projects was not changed.`);
    navigate({ name: "sources" });
  };

  return (
    <div className="source">
      <header className="project-head">
        <div className="project-identity">
          <h1 className="project-title">{library.data?.name ?? source.name}</h1>
          <p className="project-path mono">
            {source.location}
            {source.subdir ? ` › ${source.subdir}` : ""}
          </p>
          <p className="project-understanding">
            <Status tone={fresh.tone === "muted" ? "ok" : fresh.tone}>{fresh.text}</Status>
            <span className="muted">
              {" "}
              · tracking{" "}
              {source.tracked.kind === "default"
                ? "the default branch"
                : `${source.tracked.kind} ${source.tracked.name}`}
              {source.snapshot ? ` · at ${shortId(source.snapshot)}` : ""}
            </span>
          </p>
          {source.commitSummary ? <p className="muted">{source.commitSummary}</p> : null}
        </div>
        <div className="project-actions">
          <Button size="sm" icon="refresh" busy={refresh.isPending} onClick={doRefresh}>
            {source.snapshot ? "Refresh" : "Fetch"}
          </Button>

          <Button size="sm" variant="quiet" icon="trash" onClick={() => setConfirmRemove(true)}>
            Disconnect…
          </Button>
        </div>
      </header>

      {confirmRemove ? (
        <Notice
          tone="warn"
          title={`Disconnect ${source.name}?`}
          action={
            <>
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Disconnect
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          }
        >
          Habi removes its cached copy. Skills already installed in projects stay exactly as they are.
        </Notice>
      ) : null}
      {source.warning ? (
        <Notice tone="warn" title="Review before adopting updates">
          {source.warning}
        </Notice>
      ) : null}
      {source.lastError && source.freshness !== "current" ? (
        <ErrorNotice
          error={new HabiError(source.lastError)}
          title={
            source.snapshot
              ? `Refresh failed ${relativeTime(source.lastAttemptAt)} — showing the cached copy`
              : "The library has not been fetched"
          }
        />
      ) : null}
      {refresh.isError ? (
        <ErrorNotice error={refresh.error} title="Refresh failed — the cached copy is kept" />
      ) : null}

      {!source.snapshot ? (
        <div className="page">
          <Empty
            title="Nothing fetched yet"
            action={
              <Button variant="primary" onClick={doRefresh}>
                Fetch the library
              </Button>
            }
          >
            Fetching downloads the library's content into Habi's cache. It never changes your projects.
          </Empty>
        </div>
      ) : library.isPending ? (
        <Working>Reading the cached library…</Working>
      ) : library.isError ? (
        <ErrorNotice error={library.error} />
      ) : (
        <div className="workbench">
          <div className="workbench-list">
            {library.data.description || library.data.owner ? (
              <div className="library-about">
                {library.data.description ? <p>{library.data.description}</p> : null}
                <p className="muted">
                  {library.data.owner ? `Maintained by ${library.data.owner}` : null}
                  {library.data.contact ? ` · ${library.data.contact}` : null}
                </p>
              </div>
            ) : null}
            <div className="list-filter">
              <Icon name="search" />
              <label className="visually-hidden" htmlFor="lib-filter">
                Search this library
              </label>
              <input
                id="lib-filter"
                type="search"
                placeholder="Search this library"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {library.data.diagnostics.length > 0 ? (
              <details className="diagnostics">
                <summary>{library.data.diagnostics.length} notes from reading this library</summary>
                <ul>
                  {library.data.diagnostics.map((d, i) => (
                    <li key={i}>
                      <strong>{d.level}</strong> {d.path ? <span className="mono">{d.path}: </span> : null}
                      {d.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <ul className="rec-list">
              {items.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  active={i.id === selected?.id}
                  onSelect={() => navigate({ name: "sources", sourceId: source.id, itemId: i.id })}
                />
              ))}
            </ul>
            {items.length === 0 ? <Empty title="No items match." /> : null}
          </div>
          <div className="workbench-detail">
            {selected ? (
              <article className="detail">
                <header className="detail-head">
                  <p className="detail-kicker">
                    {kindLabel[selected.kind]} · {source.name}
                    {selected.owner ? ` · maintained by ${selected.owner}` : ""}
                  </p>
                  <h2 className="detail-title">{selected.title}</h2>
                  <p className="detail-desc">{selected.description}</p>
                  {selected.kind !== "instructions" ? (
                    <div className="detail-actions">
                      <Button
                        icon="pencil"
                        onClick={() =>
                          addSkills({ source: "library", sourceId: source.id, preselect: selected.id })
                        }
                      >
                        Copy to My skills to edit…
                      </Button>
                      <span className="action-hint">
                        The library copy stays as it is. Share your edits back when they are ready.
                      </span>
                    </div>
                  ) : null}
                </header>
                <div className="detail-body">
                  <Section title="Where it applies" id="applies">
                    {selected.appliesWhen || selected.excludes ? (
                      <>
                        {selected.appliesWhen ? (
                          <p>Applies when: {describeCondition(selected.appliesWhen)}</p>
                        ) : null}
                        {selected.excludes ? (
                          <p>Ruled out when: {describeCondition(selected.excludes)}</p>
                        ) : null}
                        <p className="muted">
                          Evaluated {selected.scope === "repository" ? "across the repository" : "per module"}
                          . Open a project to see whether it fits.
                        </p>
                      </>
                    ) : (
                      <p className="muted">
                        {NO_RULES_PHRASE}. Habi lists it for manual use and does not match it to projects.
                      </p>
                    )}
                  </Section>
                  <ContentPanel sourceId={source.id} itemId={selected.id} />
                </div>
              </article>
            ) : (
              <Empty title="Select an item to read it" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SourcesView({ sourceId, itemId }: { sourceId?: string; itemId?: string }) {
  const sources = useSources();
  const { navigate } = useNav();
  if (sourceId === "new") return <AddSource />;
  if (sources.isPending) return <Working>Loading libraries…</Working>;
  if (sources.isError) return <ErrorNotice error={sources.error} />;
  const source = sources.data.find((s) => s.id === sourceId);
  if (source) return <SourceDetail key={source.id} source={source} itemId={itemId} />;
  return (
    <div className="page narrow">
      <header className="skills-head">
        <div>
          <h1 className="page-title">Team libraries</h1>
          <p className="lead-sm">Shared skills your team maintains in Git, matched to your projects.</p>
        </div>
        {sources.data.length > 0 ? (
          <div className="skills-actions">
            <Button icon="plus" onClick={() => navigate({ name: "sources", sourceId: "new" })}>
              Connect a library…
            </Button>
          </div>
        ) : null}
      </header>
      {sources.data.length === 0 ? (
        <Empty
          title="No library connected"
          action={
            <Button
              variant="primary"
              icon="library"
              onClick={() => navigate({ name: "sources", sourceId: "new" })}
            >
              Connect a library…
            </Button>
          }
        >
          Optional. Habi is useful with only a project and your own skills; a library adds what your team has
          already written.
        </Empty>
      ) : (
        <ul className="source-list">
          {sources.data.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="recent-row"
                onClick={() => navigate({ name: "sources", sourceId: s.id })}
              >
                <span className="recent-name">{s.name}</span>
                <span className="recent-path mono">{s.location}</span>
                <span className={`recent-when tone-${freshnessText(s).tone}`}>{freshnessText(s).text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
