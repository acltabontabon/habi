import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import type { Source } from "../bindings/Source";
import { Icon, Mark } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { tip } from "../components/Tooltips";
import { Kbd } from "../components/ui";
import { ProjectMark, Strand } from "../components/Weave";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { type Dye, useDyes } from "../lib/dye";
import { compactCount, freshnessText, plural, relativeTime } from "../lib/format";
import { lastProject, useNav } from "../lib/nav";
import {
  keys,
  useAppInfo,
  useCatalog,
  useContributions,
  useRecentProjects,
  useRepoFacts,
  useSources,
} from "../lib/queries";
import { useNewVersionMark, useUpdates } from "../lib/updates";
import { repositoryLabel } from "./sources/SourceSheet";

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { route, navigate } = useNav();
  const { openProject } = useActions();
  const recent = useRecentProjects();
  const sources = useSources();
  const contributions = useContributions();
  const info = useAppInfo();
  const { state: update } = useUpdates();
  const version = info.data?.version;
  const unseen = useNewVersionMark(version);
  const offered = update.phase === "available" || update.phase === "installing" || update.phase === "ready";
  const [allProjects, setAllProjects] = useState(false);
  const client = useQueryClient();
  const toast = useToast();

  const inProgress = (contributions.data ?? []).filter(
    (c) => c.state === "draft" || c.state === "committed",
  ).length;
  const hasSharing = (contributions.data ?? []).length > 0;
  const PROJECTS_SHOWN = 8;
  const allRecent = recent.data ?? [];
  const projects = allProjects ? allRecent : allRecent.slice(0, PROJECTS_SHOWN);

  const forget = async (projectId: string, name: string) => {
    try {
      await api.forgetProject(projectId);
      void client.invalidateQueries({ queryKey: keys.recent });
      if (route.name === "project" && route.projectId === projectId) navigate({ name: "welcome" });
      toast.show(`${name} removed from the list. Nothing on disk was changed.`);
    } catch (e) {
      toast.show(`Could not remove ${name}: ${e instanceof Error ? e.message : String(e)}`, "danger");
    }
  };
  const libraries = sources.data ?? [];
  const team = libraries.filter((l) => l.role === "team");
  const community = libraries.filter((l) => l.role === "community");
  const dyes = useDyes();
  const activeLibrary = route.name === "sources" ? route.sourceId : undefined;
  // Looking around (the overview, a catalog preview, connecting your own).
  const connecting = route.name === "sources" && !route.sourceId;
  const openLibrary = (id: string) => navigate({ name: "sources", sourceId: id });

  return (
    <nav className="sidebar" aria-label="Habi">
      <div className="sidebar-top">
        <button type="button" className="sidebar-brand" onClick={() => navigate({ name: "welcome" })}>
          <Mark size={28} />
          <span className="sidebar-wordmark">Habi</span>
          <span className="visually-hidden"> — start screen</span>
        </button>
        {version ? (
          <button
            type="button"
            className={`sidebar-version${route.name === "about" ? " is-active" : ""}${offered ? " is-offered" : ""}`}
            aria-current={route.name === "about" ? "page" : undefined}
            title={offered ? `${update.info.version} is available — what's new` : "What's new"}
            onClick={() => navigate({ name: "about" })}
          >
            {offered ? (
              <>
                <Icon name="arrowUp" size={11} />
                {update.phase === "ready" ? "Restart" : update.info.version}
                <span className="visually-hidden"> — an update is available</span>
              </>
            ) : (
              <>
                v{version}
                {unseen ? (
                  <span className="sidebar-dot tone-ok">
                    <span className="visually-hidden"> New in this version</span>
                  </span>
                ) : null}
              </>
            )}
          </button>
        ) : null}
      </div>

      <button type="button" className="palette-trigger" onClick={onOpenPalette}>
        <Icon name="search" />
        <span>Search and commands</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="sidebar-group">
        <div className="sidebar-heading">
          <span>Projects</span>
          {projects.length > 0 ? (
            <button
              type="button"
              className="icon-btn sidebar-reveal"
              aria-label="Open a project"
              title="Open a project (⌘O)"
              onClick={() => void openProject()}
            >
              <Icon name="plus" />
            </button>
          ) : null}
        </div>
        {projects.length === 0 ? (
          <button
            type="button"
            className="sidebar-item sidebar-item-quiet"
            onClick={() => void openProject()}
          >
            <Icon name="folder" />
            <span className="sidebar-item-text">Open a project…</span>
          </button>
        ) : (
          <ul className="sidebar-list">
            {projects.map((p) => {
              const active = route.name === "project" && route.projectId === p.id;
              return (
                <li key={p.id} className={`sidebar-row${p.exists ? "" : " is-missing"}`}>
                  <button
                    type="button"
                    className={`sidebar-item${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    disabled={!p.exists}
                    title={p.exists ? p.path : `${p.path} — the folder is missing`}
                    onClick={() => navigate({ name: "project", projectId: p.id, tab: "recommendations" })}
                  >
                    <ProjectMark name={p.name} languages={p.summary?.languages ?? []} />
                    <span className="sidebar-item-text">{p.name}</span>
                    {p.sample ? <span className="sidebar-tag">sample</span> : null}
                    {!p.exists ? <span className="sidebar-tag">missing</span> : null}
                  </button>
                  {/* A missing folder cannot be opened, so its row is the only place to let it go;
                      other projects are removed from their settings. */}
                  {!p.exists ? (
                    <button
                      type="button"
                      className="icon-btn sidebar-row-action"
                      aria-label={`Remove ${p.name} from the list`}
                      title="Remove from list — nothing on disk is deleted"
                      onClick={() => void forget(p.id, p.name)}
                    >
                      <Icon name="close" />
                    </button>
                  ) : null}
                </li>
              );
            })}
            {allRecent.length > PROJECTS_SHOWN ? (
              <li>
                <button
                  type="button"
                  className="sidebar-item sidebar-item-quiet"
                  aria-expanded={allProjects}
                  onClick={() => setAllProjects((v) => !v)}
                >
                  <Icon name={allProjects ? "chevronDown" : "chevronRight"} />
                  <span className="sidebar-item-text">
                    {allProjects ? "Show fewer projects" : `Show all ${allRecent.length} projects`}
                  </span>
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="sidebar-group">
        <button
          type="button"
          className={`sidebar-item${route.name === "skills" ? " is-active" : ""}`}
          aria-current={route.name === "skills" ? "page" : undefined}
          onClick={() => navigate({ name: "skills" })}
        >
          <Icon name="pencil" />
          <span className="sidebar-item-text">My skills</span>
        </button>
      </div>

      <div className="sidebar-group">
        <div className="sidebar-heading">
          <button
            type="button"
            className="sidebar-heading-link"
            aria-current={route.name === "sources" && !route.sourceId ? "page" : undefined}
            onClick={() => navigate({ name: "sources" })}
          >
            Libraries
          </button>
        </div>
        {/* One family of sources on one warp; the collection continues into
            "Explore libraries". Provenance is in each thread (stitched for
            community) and in the tooltip, not in headings. */}
        <ul className="sidebar-list sidebar-spine">
          {[...team, ...community].map((s) => (
            <LibraryItem
              key={s.id}
              source={s}
              dye={dyes(s.id)}
              active={activeLibrary === s.id}
              projectId={route.name === "project" ? route.projectId : lastProject()}
              onOpen={openLibrary}
            />
          ))}
          <li>
            <button
              type="button"
              className={`sidebar-explore${connecting ? " is-here" : ""}`}
              aria-current={connecting ? "page" : undefined}
              onClick={() => navigate({ name: "sources" })}
            >
              <span className="sidebar-knot" aria-hidden="true" />
              <span className="sidebar-item-text">
                {libraries.length === 0 ? "Connect a library" : "Explore libraries"}
              </span>
              <span className="sidebar-explore-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </li>
        </ul>
      </div>

      {hasSharing ? (
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-item${route.name === "contributions" ? " is-active" : ""}`}
            aria-current={route.name === "contributions" ? "page" : undefined}
            onClick={() => navigate({ name: "contributions" })}
          >
            <Icon name="share" />
            <span className="sidebar-item-text">Contributions</span>
            {inProgress > 0 ? (
              <span className="sidebar-count">
                {inProgress}
                <span className="visually-hidden"> in progress</span>
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

      <div className="sidebar-foot">
        {/* The version at the top carries the dot; in the icon rail it is hidden, so the dot moves here. */}
        <button
          type="button"
          className={`sidebar-item${route.name === "settings" ? " is-active" : ""}`}
          aria-current={route.name === "settings" ? "page" : undefined}
          onClick={() => navigate({ name: "settings" })}
          title="Settings (⌘,)"
        >
          <Icon name="settings" />
          <span className="sidebar-item-text">Settings</span>
          {offered ? (
            <span className="sidebar-dot sidebar-dot-rail tone-warn">
              <span className="visually-hidden"> An update is available</span>
            </span>
          ) : unseen ? (
            <span className="sidebar-dot sidebar-dot-rail tone-ok">
              <span className="visually-hidden"> New in this version</span>
            </span>
          ) : null}
        </button>
      </div>
    </nav>
  );
}

/**
 * The library's card on hover: what it is, how much it holds, how it is
 * doing upstream (stars and last push, for a catalog library, asked of
 * GitHub only once someone looks), and what it means for the project being
 * worked on.
 */
function LibraryItem({
  source,
  dye,
  active,
  projectId,
  onOpen,
}: {
  source: Source;
  dye: Dye;
  active: boolean;
  /** The project being worked on, if any: its overview says what fits. */
  projectId: string | null;
  onOpen: (id: string) => void;
}) {
  const fresh = freshnessText(source);
  // Counts hovers: each look re-reads what is known (a project opened since may say what fits).
  const [looks, setLooks] = useState(0);
  const peeked = looks > 0;
  const client = useQueryClient();
  const entry = useCatalog().data?.find((e) => e.id === source.catalogId);
  const facts = useRepoFacts(peeked ? (source.catalogId ?? undefined) : undefined).data;
  // Only what is already known: hovering never runs a project's inspection.
  const overview =
    peeked && projectId ? client.getQueryData<ProjectOverview>(keys.overview(projectId)) : undefined;
  const fits = overview?.recommendations.filter(
    (r) => r.item.sourceId === source.id && r.applicability.applicability === "applies",
  );
  const installed = fits?.filter((r) => r.installState !== "notInstalled").length ?? 0;
  const community = source.role === "community";
  // A community library says so with a badge (and its stitched thread); the others in a line.
  const kind = community
    ? null
    : source.location.startsWith("/") || source.location.startsWith("~")
      ? "Local folder"
      : "Team library";
  const counts = [
    plural(source.skillCount, "skill"),
    facts ? `★ ${compactCount(facts.stars)}` : null,
    facts?.pushedAt ? `pushed ${relativeTime(facts.pushedAt)}` : null,
    facts?.archived ? "archived" : null,
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        className={`sidebar-item${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        onPointerEnter={() => setLooks((n) => n + 1)}
        onFocus={() => setLooks((n) => n + 1)}
        {...tip({
          title: source.name,
          mark: dye.color,
          stitched: dye.community,
          badge: community ? "community" : undefined,
          lines: [
            ...(entry?.summary ? [{ text: entry.summary }] : []),
            { text: counts.join(" · ") },
            ...(overview && fits
              ? [
                  {
                    text:
                      fits.length === 0
                        ? `Nothing here fits ${overview.project.name}`
                        : `${fits.length} ${fits.length === 1 ? "fits" : "fit"} ${overview.project.name}${
                            installed > 0 ? ` · ${installed} installed` : ""
                          }`,
                  },
                ]
              : []),
            ...(kind ? [{ text: kind }] : []),
            { text: repositoryLabel(source.location), mono: true },
          ],
          note: {
            text: fresh.text,
            tone: fresh.tone === "muted" ? "ok" : fresh.tone === "thread" ? "muted" : fresh.tone,
          },
        })}
        onClick={() => onOpen(source.id)}
      >
        <Strand dye={dye} />
        <span className="sidebar-item-text">{source.name}</span>
        {source.sample ? <span className="sidebar-tag">sample</span> : null}
        {fresh.tone !== "muted" ? (
          <span className={`sidebar-dot tone-${fresh.tone}`}>
            <span className="visually-hidden">{fresh.text}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}
