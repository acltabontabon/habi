/**
 * Home. On a first run: the question, its one-line answer, and one action, opening a
 * project. Once there are projects it is a front page: what needs you most leads, and
 * the rest run down the side. Creating and adding skills live in the sidebar, the
 * palette and the project views.
 */
import { Button, ErrorNotice, Kbd, Notice, Working } from "../components/ui";
import { useActions } from "../lib/actions";
import { relativeTime } from "../lib/format";
import { useNav } from "../lib/nav";
import { modShortcut } from "../lib/platform";
import { useAppInfo, useContributions, useRecentProjects, useSources } from "../lib/queries";
import { HomeFront, type HomeNote, type HomeProject } from "./HomeFront";

const ALSO_SHOWN = 4;

export function Welcome() {
  const { navigate } = useNav();
  const { openProject, showWelcome } = useActions();
  const info = useAppInfo();
  const recent = useRecentProjects();
  const sources = useSources();
  const contributions = useContributions();

  const projects = (recent.data ?? []).filter((p) => p.exists);
  const shared = (contributions.data ?? []).filter((c) => c.state !== "discarded");

  const sourceOf = (id: string) => (sources.data ?? []).find((s) => s.id === id);

  const listed: HomeProject[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    threads: p.summary
      ? p.summary.tally.map((t) => ({
          sourceId: t.sourceId,
          sourceName: sourceOf(t.sourceId)?.name ?? "My skills",
          installed: t.installed,
          loose: Math.max(0, t.fits + t.described - t.installed.length),
        }))
      : null,
    when: relativeTime(p.lastOpenedAt),
    open: () => navigate({ name: "project", projectId: p.id, tab: "recommendations" }),
  }));

  const returning = projects.length > 0;
  // What asks something of the person and is not already a project's count.
  const also: HomeNote[] = [
    ...(sources.data ?? [])
      .filter((s) => s.lastError)
      .map((s) => ({
        key: `source:${s.id}`,
        name: s.name,
        detail: "could not be refreshed",
        go: () => navigate({ name: "sources", sourceId: s.id }),
      })),
    ...shared
      .filter((c) => c.state === "draft" || c.state === "committed")
      .map((c) => ({
        key: `contribution:${c.id}`,
        name: c.form.title,
        detail: "not sent yet",
        go: () => navigate({ name: "contributions", contributionId: c.id }),
      })),
  ];

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

      {returning ? (
        <HomeFront
          projects={listed}
          also={also.slice(0, ALSO_SHOWN)}
          onOpenAnother={() => void openProject()}
          onExplore={() => navigate({ name: "sources" })}
        />
      ) : (
        <header className="home-head">
          <h1 className="home-title">
            What one developer learns, <em>every project</em> keeps.
          </h1>
          <p className="home-lead">Find what applies. Improve what works. Share what you learn.</p>
          <p className="home-cta">
            <Button variant="primary" icon="folder" onClick={() => void openProject()}>
              Open a project…
            </Button>
            <span
              className="home-trust"
              title="Habi reads build files and folder names. Nothing is built, run or changed until you review and confirm a plan."
            >
              read-only
            </span>
          </p>
        </header>
      )}

      <footer className="home-foot">
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
