import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Icon, Mark } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Kbd } from "../components/ui";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { freshnessText } from "../lib/format";
import { useNav } from "../lib/nav";
import { keys, useContributions, useRecentProjects, useSkills, useSources } from "../lib/queries";
import { type ThemeChoice, useTheme } from "../lib/theme";

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { route, navigate } = useNav();
  const { openProject, newSkill } = useActions();
  const recent = useRecentProjects();
  const sources = useSources();
  const skills = useSkills();
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
      toast.show(`${name} removed from the list. Nothing on disk was changed.`);
    } catch (e) {
      toast.show(`Could not remove ${name}: ${e instanceof Error ? e.message : String(e)}`, "danger");
    }
  };
  const libraries = sources.data ?? [];
  const skillCount = (skills.data ?? []).filter((s) => s.deletedAt === null).length;
  const nextTheme: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };

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
          <button
            type="button"
            className="icon-btn"
            aria-label="Open a project"
            title="Open a project (⌘O)"
            onClick={() => void openProject()}
          >
            <Icon name="plus" />
          </button>
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
                <li key={p.id} className={p.exists ? undefined : "sidebar-row"}>
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
                  {!p.exists ? (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Forget ${p.name} (folder missing)`}
                      title="Forget this project — removes it from the list only"
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
        <div className="sidebar-row">
          <button
            type="button"
            className={`sidebar-item${route.name === "skills" ? " is-active" : ""}`}
            aria-current={route.name === "skills" ? "page" : undefined}
            onClick={() => navigate({ name: "skills" })}
          >
            <Icon name="pencil" />
            <span className="sidebar-item-text">My skills</span>
            {skillCount > 0 ? (
              <span className="sidebar-num">
                {skillCount}
                <span className="visually-hidden"> skills</span>
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Create a skill"
            title="Create a skill (⌘N)"
            onClick={() => newSkill()}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>

      <div className="sidebar-group">
        <div className="sidebar-heading">
          <span>Team libraries</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Connect a library"
            title="Connect a library"
            onClick={() => navigate({ name: "sources", sourceId: "new" })}
          >
            <Icon name="plus" />
          </button>
        </div>
        {libraries.length === 0 ? (
          <button
            type="button"
            className={`sidebar-item sidebar-item-quiet${route.name === "sources" ? " is-active" : ""}`}
            onClick={() => navigate({ name: "sources", sourceId: "new" })}
          >
            <Icon name="library" />
            <span className="sidebar-item-text">Connect a library…</span>
          </button>
        ) : (
          <ul className="sidebar-list">
            {libraries.map((s) => {
              const active = route.name === "sources" && route.sourceId === s.id;
              const fresh = freshnessText(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`sidebar-item${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigate({ name: "sources", sourceId: s.id })}
                  >
                    <Icon name="library" />
                    <span className="sidebar-item-text">
                      {s.name}
                      {fresh.tone !== "muted" ? (
                        <span className={`sidebar-item-sub tone-${fresh.tone}`}>{fresh.text}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
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
            <span className="sidebar-item-text">Sharing activity</span>
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
        >
          <Icon name="settings" />
          <span className="sidebar-item-text">Settings</span>
        </button>
        <button
          type="button"
          className="sidebar-item"
          onClick={() => setTheme(nextTheme[theme])}
          aria-label={`Theme: ${theme}. Switch to ${nextTheme[theme]}.`}
        >
          <Icon name={theme === "dark" ? "moon" : "sun"} />
          <span className="sidebar-item-text">Theme: {theme}</span>
        </button>
      </div>
    </nav>
  );
}
