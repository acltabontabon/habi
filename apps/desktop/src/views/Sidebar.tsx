import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Source } from "../bindings/Source";
import { Icon, Mark } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { tip } from "../components/Tooltips";
import { Kbd } from "../components/ui";
import { Strand } from "../components/Weave";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { type Dye, useDyes } from "../lib/dye";
import { freshnessText } from "../lib/format";
import { useNav } from "../lib/nav";
import { keys, useContributions, useRecentProjects, useSources } from "../lib/queries";
import { type ThemeChoice, useTheme } from "../lib/theme";
import { repositoryLabel } from "./sources/SourceSheet";

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { route, navigate } = useNav();
  const { openProject } = useActions();
  const recent = useRecentProjects();
  const sources = useSources();
  const contributions = useContributions();
  const [theme, setTheme] = useTheme();
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
      <button type="button" className="sidebar-brand" onClick={() => navigate({ name: "welcome" })}>
        <Mark size={22} />
        <span className="sidebar-wordmark">Habi</span>
        <span className="visually-hidden"> — start screen</span>
      </button>

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
                    <Icon name="folder" />
                    <span className="sidebar-item-text">{p.name}</span>
                    {p.sample ? <span className="sidebar-tag">sample</span> : null}
                    {!p.exists ? <span className="sidebar-tag">missing</span> : null}
                  </button>
                  <button
                    type="button"
                    className="icon-btn sidebar-row-action"
                    aria-label={`Remove ${p.name} from the list`}
                    title="Remove from list — nothing on disk is deleted"
                    onClick={() => void forget(p.id, p.name)}
                  >
                    <Icon name="close" />
                  </button>
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
        <button
          type="button"
          className={`sidebar-item${route.name === "settings" ? " is-active" : ""}`}
          aria-current={route.name === "settings" ? "page" : undefined}
          onClick={() => navigate({ name: "settings" })}
          title="Settings (⌘,)"
        >
          <Icon name="settings" />
          <span className="sidebar-item-text">Settings</span>
        </button>
        <button
          type="button"
          className="sidebar-theme"
          onClick={() => setTheme(NEXT_THEME[theme])}
          title={`Theme: ${THEME_LABEL[theme]} — switch to ${THEME_LABEL[NEXT_THEME[theme]].toLowerCase()}`}
          aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[NEXT_THEME[theme]].toLowerCase()}.`}
        >
          <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "contrast"} />
        </button>
      </div>
    </nav>
  );
}

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<ThemeChoice, string> = { system: "Match the system", light: "Light", dark: "Dark" };

function LibraryItem({
  source,
  dye,
  active,
  onOpen,
}: {
  source: Source;
  dye: Dye;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const fresh = freshnessText(source);
  return (
    <li>
      <button
        type="button"
        className={`sidebar-item${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        {...tip({
          title: source.name,
          mark: dye.color,
          stitched: dye.community,
          lines: [
            {
              text:
                source.role === "community"
                  ? "Community library · not reviewed by your team"
                  : source.location.startsWith("/") || source.location.startsWith("~")
                    ? "Local folder"
                    : "Team library",
            },
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
