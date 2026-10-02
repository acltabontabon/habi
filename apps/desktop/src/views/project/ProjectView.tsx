/** Project home: identity, a concise understanding, and the workbench. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Label, Notice, Working } from "../../components/ui";
import { Strand, Swatch } from "../../components/Weave";
import { api } from "../../lib/api";
import { useDyes } from "../../lib/dye";
import { plural } from "../../lib/format";
import { type ProjectTab, useNav } from "../../lib/nav";
import { staleKey } from "../../lib/ownChanges";
import { useSafeInvoke } from "../../lib/safeInvoke";
import { tabKeyHandler } from "../../lib/tabs";
import { tagLabel } from "../../lib/tags";

export { tagLabel };

import { useOverview } from "../../lib/queries";
import { EvidenceView } from "./EvidenceView";
import { FoundView } from "./FoundView";
import { InstalledView } from "./InstalledView";
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

export function ProjectView({
  projectId,
  tab,
  itemKey,
}: {
  projectId: string;
  tab: ProjectTab;
  itemKey?: string;
}) {
  const { navigate } = useNav();
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
  const facts = useMemo(() => (data ? understanding(data) : []), [data]);
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
  const tabs: { id: ProjectTab; label: string }[] = [
    { id: "recommendations", label: "Recommendations" },
    { id: "found", label: "In this project" },
    { id: "evidence", label: "Project facts" },
    { id: "installed", label: "Installed & history" },
  ];
  const installedCount = data.recommendations.filter((r) => r.installation).length + data.orphaned.length;
  const selectTab = (id: ProjectTab) => navigate({ name: "project", projectId, tab: id, itemKey });
  const onTabKey = tabKeyHandler(
    tabs.map((t) => t.id),
    tab,
    selectTab,
    (id) => `tab-${id}`,
  );

  return (
    <div className="project">
      <header className="project-head project-head-woven">
        <Swatch
          dyes={weave.map((w) => w.dye)}
          seed={project.id}
          size={72}
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
              facts.map((f) => (
                <li key={f} className="stack-token">
                  {f}
                </li>
              ))
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

      <div className="tabs" role="tablist" aria-label="Project views">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => selectTab(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
            {t.id === "installed" && installedCount > 0 ? (
              <span className="tab-count">{installedCount}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="project-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "recommendations" && !itemKey && !data.recommendations.some(fitsProject) ? (
          // Nothing to recommend is not a dead end: show what is already here
          // and what can be done with only this project.
          <FoundView project={project} lead />
        ) : tab === "found" ? (
          <FoundView project={project} />
        ) : tab === "recommendations" ? (
          <Workbench overview={data} itemKey={itemKey} />
        ) : tab === "evidence" ? (
          <EvidenceView overview={data} />
        ) : (
          <InstalledView overview={data} />
        )}
      </div>
    </div>
  );
}
