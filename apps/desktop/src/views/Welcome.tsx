/**
 * First screen: one promise, one primary action. A project alone is enough
 * to start; creating a skill and adding existing ones are close at hand, and
 * a team library is optional.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Button, ErrorNotice, Kbd } from "../components/ui";
import { useActions } from "../lib/actions";
import { api } from "../lib/api";
import { type Dye, dyeMap } from "../lib/dye";
import { relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import { invalidateProjectData, keys, useRecentProjects, useSkills, useSources } from "../lib/queries";

/**
 * Decorative loom. Its warp is your libraries — each one a thread color,
 * community libraries stitched — with the ochre weft drawn through once and
 * the woven cloth below. With no libraries, it is a bare loom.
 */
function Loom({ dyes }: { dyes: Dye[] }) {
  const count = 12;
  const pitch = 23;
  const left = 24;
  const xs = Array.from({ length: count }, (_, i) => left + i * pitch);
  const threadDye = (i: number): Dye | undefined =>
    dyes.length > 0 ? dyes[Math.floor((i * dyes.length) / count)] : undefined;
  const weftY = 196;
  const clothTop = 226;
  const rows = 15;
  const rowH = 11;
  const over = (c: number, r: number) => (c + r) % 2 === 0;
  return (
    <svg className="loom" viewBox="0 0 300 400" aria-hidden="true" focusable="false">
      {xs.map((x, i) => {
        const dye = threadDye(i);
        return (
          <line
            key={x}
            x1={x}
            y1="0"
            x2={x}
            y2={clothTop}
            className="loom-warp"
            style={dye ? { stroke: dye.color } : undefined}
            strokeDasharray={dye?.community ? "7 5" : undefined}
          />
        );
      })}
      <path
        className="loom-weft"
        d={`M0 ${weftY} ${xs
          .map(
            (x, i) =>
              `C ${x - 14} ${weftY + (i % 2 ? -9 : 9)}, ${x + 14} ${weftY + (i % 2 ? -9 : 9)}, ${x + pitch / 2} ${weftY}`,
          )
          .join(" ")} L 300 ${weftY}`}
      />
      {xs.map((x, i) =>
        i % 2 === 0 ? (
          <line
            key={`o${x}`}
            x1={x}
            y1={weftY - 7}
            x2={x}
            y2={weftY + 7}
            className="loom-warp loom-warp-over"
            style={threadDye(i) ? { stroke: threadDye(i)?.color } : undefined}
          />
        ) : null,
      )}
      <g className="loom-cloth">
        {Array.from({ length: rows }, (_, r) => {
          const y = clothTop + r * rowH;
          return (
            <g key={r} style={{ animationDelay: `${900 + (rows - r) * 45}ms` }}>
              <rect
                x={left - pitch / 2}
                y={y + 2}
                width={count * pitch}
                height={rowH - 4}
                rx="3.5"
                className={r % 5 === 2 ? "loom-cell-accent" : "loom-cell-weft"}
              />
              {xs.map((x, c) => {
                const dye = threadDye(c);
                return over(c, r) ? (
                  <rect
                    key={x}
                    x={x - 4.5}
                    y={y - 1}
                    width="9"
                    height={rowH + 2}
                    rx="4.5"
                    className="loom-cell-warp"
                    style={dye ? { fill: dye.color } : undefined}
                    opacity={dye?.community ? 0.75 : undefined}
                  />
                ) : null;
              })}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, newSkill, addSkills } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const loomDyes = useMemo(() => [...dyeMap(sources.data ?? []).values()], [sources.data]);
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
        <h1 className="display">
          What does your team know that helps in <em>this repository</em>?
        </h1>
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
          <span className="cli-hint">habi recommend -C path/to/project</span>
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
        <Loom dyes={loomDyes} />
      </div>
    </div>
  );
}
