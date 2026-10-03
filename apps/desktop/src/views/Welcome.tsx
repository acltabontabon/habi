/**
 * Home: the question, its one-line answer, and the loom —
 * your libraries across your projects, with the next project as an unwoven
 * row. One next step leads: open a project. On first run the sample
 * workspace and connecting a library are quiet links beneath; the rest lives
 * in the sidebar, the palette and the project views.
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
  const { openProject } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const contributions = useContributions();
  const dyes = useDyes();
  const sample = useCreateSample();

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

      <footer className="home-foot">
        {projects.length === 0 ? (
          <p className="home-more">
            Or{" "}
            <button
              type="button"
              className="link-quiet"
              disabled={sample.busy}
              title="Example libraries and projects, all labeled. Everything stays on this machine."
              onClick={() => void sample.create()}
            >
              {sample.busy ? "Setting up the sample…" : "try the sample workspace"}
            </button>{" "}
            ·{" "}
            <button type="button" className="link-quiet" onClick={() => navigate({ name: "sources" })}>
              connect a library
            </button>
          </p>
        ) : null}
        <p className="home-keys">
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
