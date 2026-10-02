/**
 * Home: the question, the lifecycle at a glance, and the loom — your
 * knowledge sources woven through your projects, with the next project as
 * an unwoven row. Creating skills, connecting libraries and the rest live
 * in the sidebar, the palette and the project views; their shortcuts are at
 * the foot.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Kbd } from "../components/ui";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { useDyes } from "../lib/dye";
import { plural, relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import {
  invalidateProjectData,
  keys,
  useContributions,
  useLibraries,
  useRecentProjects,
  useSkills,
  useSources,
} from "../lib/queries";
import { Loom, type LoomProject, type LoomSource } from "./Loom";

const LOCAL = "local";
const SHOWN = 7;

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, newSkill } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const contributions = useContributions();
  const libraries = useLibraries(sources.data ?? []);
  const dyes = useDyes();
  const client = useQueryClient();
  const toast = useToast();
  const [sampleBusy, setSampleBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const createSample = async () => {
    setError(null);
    setSampleBusy(true);
    try {
      const sample = await api.createSampleWorkspace();
      invalidateProjectData(client);
      void client.invalidateQueries({ queryKey: keys.recent });
      toast.show("Sample workspace ready. Everything in it is example data.");
      const first = sample.projects[0];
      if (first) navigate({ name: "project", projectId: first.id, tab: "recommendations" });
    } catch (e) {
      setError(e);
    } finally {
      setSampleBusy(false);
    }
  };

  const projects = (recent.data ?? []).filter((p) => p.exists);
  const drafts = (skills.data ?? []).filter((s) => s.deletedAt === null);
  const shared = (contributions.data ?? []).filter((c) => c.state !== "discarded");
  const moving = shared.filter((c) => !c.inLibrary);
  const libraryKey = libraries.map((q) => q.data?.snapshot ?? "").join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: libraryKey stands for the library indexes.
  const loomSources = useMemo(() => {
    const list: LoomSource[] = [];
    for (const s of [...(sources.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!s.snapshot) continue;
      const index = libraries.find((q) => q.data?.sourceId === s.id)?.data;
      const count = (index?.items ?? []).filter((i) => i.kind !== "instructions").length;
      list.push({ id: s.id, name: s.name, dye: dyes(s.id), kind: s.role, skills: count });
    }
    if (drafts.length > 0)
      list.push({ id: LOCAL, name: "My skills", dye: dyes(LOCAL), kind: "mine", skills: drafts.length });
    return list;
  }, [sources.data, libraryKey, drafts.length, dyes]);

  const loomProjects: LoomProject[] = projects.slice(0, SHOWN).map((p) => ({
    id: p.id,
    name: p.name,
    sources: p.summary?.sources ?? null,
    sharedTo: shared
      .filter((c) => c.origin.type === "projectSkill" && c.origin.projectId === p.id)
      .map((c) => c.sourceId),
    meta: p.summary
      ? `${plural(p.summary.fits, "skill")} · ${plural(p.summary.sources.length, "source")}`
      : "not matched yet",
    when: relativeTime(p.lastOpenedAt),
  }));

  const total = loomSources.filter((s) => s.kind !== "mine").reduce((n, s) => n + s.skills, 0);
  const libraryCount = loomSources.filter((s) => s.kind !== "mine").length;

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1 className="home-title">
            What one developer learns, <em>every project</em> keeps.
          </h1>
          <p className="home-lead">Find what applies. Improve what works. Share what you learn.</p>
        </div>
        <dl className="home-cycle">
          <div>
            <dt>Sources</dt>
            <dd>
              {libraryCount > 0 ? (
                <button type="button" className="link-quiet" onClick={() => navigate({ name: "sources" })}>
                  {plural(libraryCount, "library", "libraries")} · {plural(total, "skill")}
                </button>
              ) : (
                <button
                  type="button"
                  className="link-quiet"
                  onClick={() => navigate({ name: "sources", sourceId: "new" })}
                >
                  Connect a library
                </button>
              )}
            </dd>
          </div>
          <div>
            <dt>Refining</dt>
            <dd>
              {drafts.length > 0 ? (
                <button type="button" className="link-quiet" onClick={() => navigate({ name: "skills" })}>
                  {plural(drafts.length, "skill")} of yours
                </button>
              ) : (
                <button type="button" className="link-quiet" onClick={() => newSkill()}>
                  Write a skill
                </button>
              )}
            </dd>
          </div>
          <div>
            <dt>Shared</dt>
            <dd>
              {shared.length > 0 ? (
                <button
                  type="button"
                  className="link-quiet"
                  onClick={() => navigate({ name: "contributions" })}
                >
                  {moving.length > 0
                    ? `${plural(moving.length, "contribution")} under way`
                    : `${plural(shared.length, "contribution")} in libraries`}
                </button>
              ) : (
                <span className="muted">nothing yet</span>
              )}
            </dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorNotice error={error} /> : null}

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
          <p>
            New here?{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => void createSample()}
              disabled={sampleBusy}
            >
              {sampleBusy ? "Creating the sample workspace…" : "Explore a sample workspace"}
            </button>{" "}
            — example libraries and projects, all labeled. Everything stays on this machine.
          </p>
        ) : null}
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
