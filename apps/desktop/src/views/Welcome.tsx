/**
 * Home: the question, its one-line answer, and the loom —
 * your libraries across your projects, with the next project as an unwoven
 * row. One next step leads: open a project. On first run connecting a
 * library is a quiet link beneath; the rest lives in the sidebar, the
 * palette and the project views.
 *
 * Once there are projects the question has been answered: it shrinks to one
 * line, and the cloth takes the page, with what waits on you in its margin.
 */
import { useMemo } from "react";
import { Button, ErrorNotice, Kbd, Notice, Working } from "../components/ui";
import { useActions } from "../lib/actions";
import { useDyes } from "../lib/dye";
import { plural, relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import { modShortcut } from "../lib/platform";
import { useAppInfo, useContributions, useRecentProjects, useSkills, useSources } from "../lib/queries";
import { Loom, LoomKey, type LoomNote, type LoomProject, type LoomSource } from "./Loom";

const LOCAL = "local";
const SHOWN = 7;
const ELSEWHERE_SHOWN = 4;

/** What fits a project, with fits Habi read from descriptions said apart from declared ones. */
function fitsMeta(s: { fits: number; described: number }): string {
  if (s.described === 0) return plural(s.fits, "skill");
  const described = `${s.described} from ${s.described === 1 ? "its description" : "their descriptions"}`;
  return s.fits === 0
    ? `${plural(s.described, "skill")}, from ${s.described === 1 ? "its description" : "their descriptions"}`
    : `${plural(s.fits, "skill")} · ${described}`;
}

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, showWelcome } = useActions();
  const info = useAppInfo();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const contributions = useContributions();
  const dyes = useDyes();

  const projects = (recent.data ?? []).filter((p) => p.exists);
  const drafts = (skills.data ?? []).filter((s) => s.deletedAt === null);
  const shared = (contributions.data ?? []).filter((c) => c.state !== "discarded");

  const loomSources = useMemo(() => {
    const list: LoomSource[] = [];
    for (const s of [...(sources.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!s.snapshot) continue;
      list.push({ id: s.id, name: s.name, dye: dyes(s.id), kind: s.role, skills: s.skillCount });
    }
    if (drafts.length > 0)
      list.push({ id: LOCAL, name: "My skills", dye: dyes(LOCAL), kind: "mine", skills: drafts.length });
    return list;
  }, [sources.data, drafts.length, dyes]);

  const loomProjects: LoomProject[] = projects.slice(0, SHOWN).map((p) => ({
    id: p.id,
    name: p.name,
    sources: p.summary?.sources ?? null,
    tally: p.summary?.tally,
    sharedTo: shared
      .filter((c) => c.origin.type === "projectSkill" && c.origin.projectId === p.id)
      .map((c) => c.sourceId),
    meta: p.summary
      ? `${fitsMeta(p.summary)} · ${plural(p.summary.sources.length, "library", "libraries")}`
      : "not matched yet",
    when: relativeTime(p.lastOpenedAt),
  }));

  const returning = projects.length > 0;
  // Only what asks something of the person, each read from what Habi already knows. A note about a
  // project goes at the end of its thread, one to a thread; the rest is listed under the margin.
  const rows = new Map(loomProjects.map((p) => [p.id, p]));
  const elsewhere: LoomNote[] = (sources.data ?? [])
    .filter((s) => s.lastError)
    .map((s) => ({
      key: `source:${s.id}`,
      name: s.name,
      detail: "could not be refreshed",
      go: () => navigate({ name: "sources", sourceId: s.id }),
    }));
  const place = (projectId: string | null, note: LoomNote) => {
    const row = projectId ? rows.get(projectId) : undefined;
    if (row && !row.note) row.note = note;
    else elsewhere.push(note);
  };
  for (const c of shared) {
    if (c.state !== "draft" && c.state !== "committed") continue;
    place(c.origin.type === "projectSkill" ? c.origin.projectId : null, {
      key: `contribution:${c.id}`,
      name: c.form.title,
      detail: "not sent yet",
      go: () => navigate({ name: "contributions", contributionId: c.id }),
    });
  }
  for (const p of projects) {
    if (!p.summary || p.summary.fits === 0 || p.summary.installed > 0) continue;
    place(p.id, {
      key: `project:${p.id}`,
      name: p.name,
      detail: `${plural(p.summary.fits, "skill")} ${p.summary.fits === 1 ? "fits" : "fit"}, none added`,
      go: () => navigate({ name: "project", projectId: p.id, tab: "recommendations" }),
    });
  }

  // Until the projects are known, a returning user must not see the first-run screen.
  if (recent.isPending) {
    return (
      <div className="startup">
        <Working>Loading your projects…</Working>
      </div>
    );
  }
  if (recent.isError) {
    return (
      <div className="startup">
        <ErrorNotice
          error={recent.error}
          title="Habi could not list your projects"
          action={
            <Button size="sm" onClick={() => void recent.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={`home${returning ? " is-returning" : ""}`}>
      <header className="home-head">
        <h1 className="home-title">
          What one developer learns, <em>every project</em> keeps.
        </h1>
        {returning ? null : (
          <p className="home-lead">Find what applies. Improve what works. Share what you learn.</p>
        )}
        {info.data && !info.data.gitAvailable ? (
          <div className="home-setup">
            <Notice
              tone="warn"
              title="Git is not installed"
              action={
                <Button size="sm" onClick={showWelcome}>
                  Set up
                </Button>
              }
            >
              Habi needs it to pull libraries from GitHub, GitLab or any Git host.
            </Notice>
          </div>
        ) : null}
      </header>

      <Loom
        sources={loomSources}
        projects={loomProjects}
        moreProjects={Math.max(0, projects.length - SHOWN)}
        elsewhere={elsewhere.slice(0, ELSEWHERE_SHOWN)}
        onOpenProject={(id) => navigate({ name: "project", projectId: id, tab: "recommendations" })}
        onOpenSource={(id) =>
          id === LOCAL ? navigate({ name: "skills" }) : navigate({ name: "sources", sourceId: id })
        }
        newRow={
          <span className="home-cta">
            <Button variant="primary" icon="folder" onClick={() => void openProject()}>
              Open a project…
            </Button>
            <span
              className="home-trust"
              title="Habi reads build files and folder names. Nothing is built, run or changed until you review and confirm a plan."
            >
              read-only
            </span>
          </span>
        }
      />

      <footer className="home-foot">
        {returning && loomSources.length > 0 ? (
          <LoomKey
            community={loomSources.some((s) => s.kind === "community")}
            shared={loomProjects.some((p) => p.sharedTo.length > 0)}
          />
        ) : null}
        <div className="home-left">
          {projects.length === 0 ? (
            <p className="home-more">
              Or{" "}
              <button type="button" className="link-quiet" onClick={() => navigate({ name: "sources" })}>
                connect a library
              </button>
            </p>
          ) : null}
          <button type="button" className="link-quiet" onClick={() => navigate({ name: "privacy" })}>
            What leaves this machine
          </button>
        </div>
        <p className="home-keys">
          <span>
            <Kbd>{modShortcut("N")}</Kbd> new skill
          </span>
          <span>
            <Kbd>{modShortcut("K")}</Kbd> everything else
          </span>
        </p>
      </footer>
    </div>
  );
}
