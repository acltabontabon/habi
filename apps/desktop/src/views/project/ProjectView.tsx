/** Project home: identity, a concise understanding, and the workbench. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Label, Notice, Working } from "../../components/ui";
import { initialsOf, Strand, Swatch } from "../../components/Weave";
import { api } from "../../lib/api";
import { useDyes } from "../../lib/dye";
import { plural } from "../../lib/format";
import type { ProjectTab } from "../../lib/nav";
import { staleKey } from "../../lib/ownChanges";
import { useSafeInvoke } from "../../lib/safeInvoke";
import { tagLabel } from "../../lib/tags";

export { tagLabel };

import { useOverview } from "../../lib/queries";
import { stackDye, stackDyes } from "../../lib/stackDye";
import { SampleBanner } from "../SampleWorkspace";
import { NothingFits } from "./AlreadyHere";
import { History } from "./History";
import { ProjectSettings } from "./ProjectSettings";
import { fitsProject, Workbench } from "./Workbench";

export function understanding(overview: ProjectOverview): string[] {
  const { inspection } = overview;
  const tags = new Map<string, number>();
  for (const f of inspection.facts) {
    if (f.subject.type === "tag" && !f.subject.tag.startsWith("agents:")) {
      tags.set(f.subject.tag, (tags.get(f.subject.tag) ?? 0) + 1);
    }
  }
  const order = ["framework:", "lang:", "orm:", "db:", "api:", "build:", "test:", "ci:", "container:"];
  const labels = [...tags.keys()]
    .sort((a, b) => order.findIndex((p) => a.startsWith(p)) - order.findIndex((p) => b.startsWith(p)))
    .map(tagLabel);
  return [...new Set(labels)].slice(0, 9);
}

/** The project's languages, the most used first. */
export function languages(overview: ProjectOverview): string[] {
  const counts = new Map<string, number>();
  for (const f of overview.inspection.facts) {
    if (f.subject.type === "tag" && f.subject.tag.startsWith("lang:")) {
      counts.set(f.subject.tag, (counts.get(f.subject.tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tagLabel(tag));
}

export function ProjectView({
  projectId,
  tab,
  itemKey,
}: {
  projectId: string;
  tab: ProjectTab;
  itemKey?: string;
}) {
  const overview = useOverview(projectId);
  const client = useQueryClient();
  const safely = useSafeInvoke();
  const changed = useQuery<string[] | null>({
    queryKey: staleKey(projectId),
    queryFn: () => null,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Watch this project for changes while it is open.
  const [watchError, setWatchError] = useState<unknown>(null);
  // Nothing fits, and the person asked to see the skills to use by hand.
  const [browsing, setBrowsing] = useState(false);
  const [settings, setSettings] = useState(false);
  // "history" opens the project with its history showing.
  const [history, setHistory] = useState(tab === "history");
  useEffect(() => {
    let live = true;
    setWatchError(null);
    api.watchProject(projectId).catch((e: unknown) => {
      if (live) setWatchError(e);
    });
    return () => {
      live = false;
      void api.unwatchProject(projectId).catch(() => undefined);
    };
  }, [projectId]);

  const rescan = () => {
    client.setQueryData(staleKey(projectId), null);
    void overview.rescan();
  };

  const data = overview.data;
  const byHand = (data?.recommendations ?? []).filter(
    (r) => r.group === "available" && r.installState === "notInstalled",
  ).length;
  const facts = useMemo(() => (data ? understanding(data) : []), [data]);
  // The project's own colors: its languages' dyes, woven into its swatch.
  const cloth = useMemo(() => (data ? stackDyes(languages(data)) : []), [data]);
  const dyes = useDyes();
  // The libraries this project is woven from: those with items that fit it
  // (or that the team requires), in order of how much they contribute.
  const weave = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const r of data?.recommendations ?? []) {
      if (r.applicability.applicability !== "applies") continue;
      const entry = counts.get(r.item.sourceId) ?? { id: r.item.sourceId, name: r.item.sourceName, count: 0 };
      entry.count += 1;
      counts.set(r.item.sourceId, entry);
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((w) => ({ ...w, dye: dyes(w.id) }));
  }, [data, dyes]);

  if (overview.isPending) {
    return (
      <div className="page">
        <Working onCancel={overview.cancel}>
          Inspecting the project — reading manifests and file names…
        </Working>
      </div>
    );
  }
  if (overview.isError || !data) {
    return (
      <div className="page">
        <ErrorNotice
          error={overview.error}
          title="Habi could not inspect this project"
          action={
            <Button size="sm" onClick={() => void overview.rescan()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const { project, inspection } = data;
  const modules = inspection.modules.filter((m) => m.ecosystems.length > 0);
  return (
    <div className="project">
      <header className="project-head project-head-woven">
        <Swatch
          dyes={weave.map((w) => w.dye)}
          seed={project.id}
          size={80}
          weft={cloth}
          initials={initialsOf(project.name)}
          label={
            weave.length > 0
              ? `Skills from ${weave.map((w) => w.name).join(", ")}`
              : "Nothing from your libraries fits yet"
          }
        />
        <div className="project-identity">
          <p className="kicker">
            {inspection.repository.isMonorepo ? "Monorepo" : "Project"}
            {project.sample ? " · sample" : ""}
          </p>
          <div className="project-title-row">
            <h1 className="project-title">{project.name}</h1>
            {project.sample ? <Label tone="thread">Sample project</Label> : null}
          </div>
          <p className="project-path mono" title={project.path}>
            {project.path}
            {inspection.repository.branch ? (
              <span className="project-branch">
                <Icon name="branch" size={13} /> {inspection.repository.branch}
              </span>
            ) : null}
          </p>
          <ul className="stack-tokens" aria-label="What Habi recognized">
            {facts.length > 0 ? (
              facts.map((f) => {
                const dye = stackDye(f);
                return (
                  <li
                    key={f}
                    className={`stack-token${dye ? " is-dyed" : ""}`}
                    style={dye ? ({ "--dye": dye } as CSSProperties) : undefined}
                  >
                    {f}
                  </li>
                );
              })
            ) : (
              <li className="stack-token stack-token-quiet">no recognized frameworks or languages</li>
            )}
            <li className="stack-token stack-token-quiet">{plural(Math.max(modules.length, 1), "module")}</li>
          </ul>
        </div>
        <div className="project-actions">
          <Button
            size="sm"
            icon="refresh"
            onClick={rescan}
            busy={overview.isFetching}
            title="Look at the project again"
          >
            Rescan
          </Button>
          <button
            type="button"
            className="icon-btn"
            aria-label="History"
            data-tip="History — every change Habi made here, with restore"
            onClick={() => setHistory(true)}
          >
            <Icon name="history" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Project settings"
            data-tip="Project settings — paths to leave out, your corrections, removing it from Habi"
            onClick={() => setSettings(true)}
          >
            <Icon name="settings" />
          </button>
          <Button
            size="sm"
            icon="external"
            variant="quiet"
            onClick={() => safely(() => api.revealProjectPath(projectId, null), "The folder was not shown")}
            title="Show the folder"
          >
            Reveal
          </Button>
        </div>
      </header>

      {settings ? <ProjectSettings overview={data} onClose={() => setSettings(false)} /> : null}
      {history ? <History overview={data} onClose={() => setHistory(false)} /> : null}
      {project.sample ? <SampleBanner /> : null}

      {weave.length > 0 ? (
        <section className="composition" aria-label="What fits, by library">
          <div className="composition-bar" aria-hidden="true">
            {weave.map((w) => (
              <span
                key={w.id}
                className={`composition-seg${w.dye.community ? " is-community" : ""}`}
                style={{ flexGrow: w.count, "--seg": w.dye.color } as CSSProperties}
              />
            ))}
          </div>
          <ul className="composition-legend">
            {weave.map((w) => (
              <li key={w.id}>
                <Strand dye={w.dye} size={14} />
                <span>{w.name}</span>
                <span className="mono composition-count">{w.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {changed.data && changed.data.length > 0 ? (
        <Notice
          tone="unknown"
          title="Files changed in this project"
          action={
            <Button size="sm" onClick={rescan}>
              Rescan now
            </Button>
          }
        >
          <span className="mono">{changed.data.slice(0, 3).join(", ")}</span>
          {changed.data.length > 3 ? ` and ${changed.data.length - 3} more` : ""}. Recommendations may be out
          of date.
        </Notice>
      ) : null}

      {watchError ? (
        <Notice tone="unknown" title="Habi is not following changes in this project">
          Use Rescan after you change files.
          {watchError instanceof Error ? <span className="muted"> ({watchError.message})</span> : null}
        </Notice>
      ) : null}

      {inspection.scan.truncated ? (
        <Notice tone="warn" title="The scan stopped early">
          {inspection.scan.limitsHit.join(" ")} File-pattern conditions are treated as not established.
        </Notice>
      ) : null}

      <div className="project-body">
        {!itemKey && !browsing && !data.recommendations.some(fitsProject) ? (
          // Nothing fits: say so, offer what can be done with only this
          // project and what is already here, and the skills to use by hand.
          <NothingFits
            project={project}
            byHand={byHand}
            ruled={data.recommendations.filter((r) => r.group === "notApplicable").length}
            onBrowse={() => setBrowsing(true)}
          />
        ) : (
          <Workbench overview={data} itemKey={itemKey} openAvailable={browsing} />
        )}
      </div>
    </div>
  );
}
