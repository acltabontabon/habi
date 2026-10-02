/**
 * First screen: one promise, one primary action. A project alone is enough
 * to start; creating a skill and adding existing ones are close at hand, and
 * a team library is optional.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Kbd } from "../components/ui";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import { invalidateProjectData, keys, useRecentProjects, useSkills } from "../lib/queries";

/** Decorative loom: fine warp lines with one weft thread drawn through once. */
function Loom() {
  const warps = Array.from({ length: 11 }, (_, i) => 20 + i * 26);
  return (
    <svg className="loom" viewBox="0 0 300 360" aria-hidden="true" focusable="false">
      {warps.map((x) => (
        <line key={x} x1={x} y1="0" x2={x} y2="360" className="loom-warp" />
      ))}
      <path
        className="loom-weft"
        d="M0 180 C 12 180, 14 170, 20 170 S 40 190, 46 190 S 66 170, 72 170 S 92 190, 98 190 S 118 170, 124 170 S 144 190, 150 190 S 170 170, 176 170 S 196 190, 202 190 S 222 170, 228 170 S 248 190, 254 190 S 274 170, 280 170 S 292 180, 300 180"
      />
      {warps.map((x, i) =>
        i % 2 === 0 ? <circle key={`k${x}`} cx={x} cy={170} r="2.5" className="loom-knot" /> : null,
      )}
    </svg>
  );
}

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, newSkill, addSkills } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
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

  const projects = (recent.data ?? []).filter((p) => p.exists).slice(0, 4);
  const drafts = (skills.data ?? []).filter((s) => s.deletedAt === null).slice(0, 3);
  const returning = projects.length > 0 || drafts.length > 0;

  return (
    <div className="welcome">
      <div className="welcome-intro">
        <p className="eyebrow">Habi</p>
        <h1 className="display">What does your team know that helps in this repository?</h1>
        <p className="lead">
          Open a project to see the skills and instructions that apply to it — and why. Start with just a
          repository and an idea.
        </p>

        {error ? <ErrorNotice error={error} /> : null}

        <div className="welcome-primary">
          <Button variant="primary" icon="folder" className="btn-lg" onClick={() => void openProject()}>
            Open a project…
          </Button>
          <span className="welcome-shortcut muted">
            <Kbd>⌘O</Kbd> Read-only: nothing is built, run or changed.
          </span>
        </div>

        <ul className="welcome-paths" aria-label="Other ways to start">
          <li>
            <button type="button" className="welcome-path" onClick={() => newSkill()}>
              <Icon name="pencil" />
              <span>
                <span className="welcome-path-title">Create a skill</span>
                <span className="welcome-path-detail">Write down something your team keeps explaining.</span>
              </span>
            </button>
          </li>
          <li>
            <button type="button" className="welcome-path" onClick={() => addSkills()}>
              <Icon name="plus" />
              <span>
                <span className="welcome-path-title">Add existing skills</span>
                <span className="welcome-path-detail">From a project, a folder, or a Git repository.</span>
              </span>
            </button>
          </li>
        </ul>

        {returning ? (
          <div className="welcome-recent">
            {projects.length > 0 ? (
              <section aria-labelledby="recent-projects">
                <h2 id="recent-projects" className="welcome-recent-title">
                  Recent projects
                </h2>
                <ul>
                  {projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="recent-row"
                        onClick={() => navigate({ name: "project", projectId: p.id, tab: "recommendations" })}
                      >
                        <span className="recent-name">
                          {p.name}
                          {p.sample ? <span className="sidebar-tag">sample</span> : null}
                        </span>
                        <span className="recent-path mono">{p.path}</span>
                        <span className="recent-when muted">{relativeTime(p.lastOpenedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {drafts.length > 0 ? (
              <section aria-labelledby="recent-drafts">
                <h2 id="recent-drafts" className="welcome-recent-title">
                  Continue writing
                </h2>
                <ul>
                  {drafts.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="recent-row"
                        onClick={() => navigate({ name: "skills", skillId: s.id })}
                      >
                        <span className="recent-name">{s.title || "Untitled skill"}</span>
                        <span className="recent-path">{s.description || "No description yet"}</span>
                        <span className="recent-when muted">{relativeTime(s.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        <p className="welcome-foot muted">
          Everything stays on this machine — no account, no cloud service.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => void createSample()}
            disabled={sampleBusy}
          >
            {sampleBusy ? "Creating the sample workspace…" : "Explore a sample workspace"}
          </button>{" "}
          to see example libraries matched to example projects, all labeled as samples.
        </p>
      </div>
      <div className="welcome-art">
        <Loom />
      </div>
    </div>
  );
}
