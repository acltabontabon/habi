/**
 * Home: the question, where things stand in one plain line, and the loom —
 * your libraries across your projects, with the next project as an unwoven
 * row. One next step leads: open a project. On first run the sample
 * workspace is the one alternative, and connecting a library or writing a
 * skill are quiet links; everything else lives in the sidebar, the palette
 * and the project views.
 */
import { useMemo } from "react";
import { Button, ErrorNotice, Kbd, Working } from "../components/ui";
import { useActions } from "../lib/actions";
import { useDyes } from "../lib/dye";
import { plural, relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import { useContributions, useRecentProjects, useSkills, useSources } from "../lib/queries";
import { Loom, type LoomProject, type LoomSource } from "./Loom";
import { useCreateSample } from "./SampleWorkspace";

const LOCAL = "local";
const SHOWN = 7;

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, newSkill } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const contributions = useContributions();
  const dyes = useDyes();
  const sample = useCreateSample();

  const projects = (recent.data ?? []).filter((p) => p.exists);
  const drafts = (skills.data ?? []).filter((s) => s.deletedAt === null);
  const shared = (contributions.data ?? []).filter((c) => c.state !== "discarded");
  const moving = shared.filter((c) => !c.inLibrary);
  const libraryCount = (sources.data ?? []).length;

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
    sharedTo: shared
      .filter((c) => c.origin.type === "projectSkill" && c.origin.projectId === p.id)
      .map((c) => c.sourceId),
    meta: p.summary
      ? `${plural(p.summary.fits, "skill")} · ${plural(p.summary.sources.length, "library", "libraries")}`
      : "not matched yet",
    when: relativeTime(p.lastOpenedAt),
  }));

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
    <div className="home">
      <header className="home-head">
        <h1 className="home-title">
          What one developer learns, <em>every project</em> keeps.
        </h1>
        <p className="home-lead">Find what applies. Improve what works. Share what you learn.</p>
        <p className="home-status">
          {libraryCount > 0 ? (
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "sources" })}>
              {plural(libraryCount, "library", "libraries")}
            </button>
          ) : (
            "0 libraries"
          )}
          <span aria-hidden="true"> · </span>
          {drafts.length > 0 ? (
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "skills" })}>
              {drafts.length === 1 ? "1 skill of yours" : `${drafts.length} of your skills`}
            </button>
          ) : (
            "0 of your skills"
          )}
          <span aria-hidden="true"> · </span>
          {shared.length > 0 ? (
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "contributions" })}>
              {moving.length > 0
                ? `${plural(moving.length, "contribution")} under way`
                : `${plural(shared.length, "contribution")} shared`}
            </button>
          ) : (
            "nothing shared yet"
          )}
        </p>
      </header>

      <Loom
        sources={loomSources}
        projects={loomProjects}
        moreProjects={Math.max(0, projects.length - SHOWN)}
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

      {projects.length === 0 ? (
        <section className="home-start" aria-label="Getting started">
          <p className="home-next">
            Habi reads the project's build files and folder names, then shows which skills fit and why.
            Nothing changes until you review a plan.
          </p>
          <p className="home-sample">
            <Button busy={sample.busy} onClick={() => void sample.create()}>
              Try the sample workspace
            </Button>
            <span>Example libraries and projects, all labeled. Everything stays on this machine.</span>
          </p>
          <p className="home-more">
            Or{" "}
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "sources" })}>
              Connect a library
            </button>{" "}
            ·{" "}
            <button type="button" className="link-quiet" onClick={() => newSkill()}>
              Write a skill
            </button>
          </p>
        </section>
      ) : null}

      <footer className="home-foot">
        <p className="home-keys">
          <span>
            <Kbd>⌘O</Kbd> open a project
          </span>
          <span>
            <Kbd>⌘N</Kbd> new skill
          </span>
          <span>
            <Kbd>⌘K</Kbd> everything else
          </span>
        </p>
      </footer>
    </div>
  );
}
