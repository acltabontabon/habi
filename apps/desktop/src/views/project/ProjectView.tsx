/** Project home: identity, a concise understanding, and the workbench. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, Fragment, useEffect, useMemo, useState } from "react";
import type { Ecosystem } from "../../bindings/Ecosystem";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Icon } from "../../components/Icon";
import { tip } from "../../components/Tooltips";
import { Button, ErrorNotice, Label, Notice, Working } from "../../components/ui";
import { initialsOf, Strand, Swatch } from "../../components/Weave";
import { api } from "../../lib/api";
import { useDyes } from "../../lib/dye";
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

/** How a recognized technology reads on the page: what it is written in, what it is built on, or what builds and tests it. */
export type StackRole = "language" | "stack" | "tooling";

export interface StackToken {
  label: string;
  role: StackRole;
}

const TOOLING_PREFIXES = ["build:", "test:", "ci:", "container:"];
/** Frameworks first, then the data, persistence and API layers. */
const STACK_ORDER = ["framework:", "data:", "orm:", "db:", "api:"];

/**
 * What Habi recognized, in reading order: languages (most used first), then
 * what the project is built on, then its tooling.
 */
export function understanding(overview: ProjectOverview): StackToken[] {
  const tags = new Map<string, number>();
  for (const f of overview.inspection.facts) {
    if (f.subject.type === "tag" && !f.subject.tag.startsWith("agents:")) {
      tags.set(f.subject.tag, (tags.get(f.subject.tag) ?? 0) + 1);
    }
  }
  const rank = (tag: string) => {
    const i = STACK_ORDER.findIndex((p) => tag.startsWith(p));
    return i < 0 ? STACK_ORDER.length : i;
  };
  const entries = [...tags.entries()];
  const pick = (keep: (tag: string) => boolean) => entries.filter(([tag]) => keep(tag));
  const isLanguage = (tag: string) => tag.startsWith("lang:");
  const isTooling = (tag: string) => TOOLING_PREFIXES.some((p) => tag.startsWith(p));
  const grouped: [StackRole, string[]][] = [
    [
      "language",
      pick(isLanguage)
        .sort((a, b) => b[1] - a[1])
        .map(([tag]) => tag),
    ],
    [
      "stack",
      pick((t) => !isLanguage(t) && !isTooling(t))
        .sort((a, b) => rank(a[0]) - rank(b[0]))
        .map(([tag]) => tag),
    ],
    ["tooling", pick(isTooling).map(([tag]) => tag)],
  ];
  const seen = new Set<string>();
  const tokens: StackToken[] = [];
  for (const [role, group] of grouped) {
    for (const tag of group) {
      const label = tagLabel(tag);
      if (seen.has(label)) continue;
      seen.add(label);
      tokens.push({ label, role });
    }
  }
  return tokens.slice(0, 9);
}

/** The language a build ecosystem's modules are written in. */
const ECOSYSTEM_LANGUAGE: Record<Ecosystem, string> = {
  maven: "Java",
  gradle: "Java",
  npm: "JavaScript",
  go: "Go",
  cargo: "Rust",
  pypi: "Python",
  composer: "PHP",
};

/**
 * The project's languages, the most used first; before any source file is
 * seen, the languages its build files are for.
 */
export function languages(overview: ProjectOverview): string[] {
  const counts = new Map<string, number>();
  for (const f of overview.inspection.facts) {
    if (f.subject.type === "tag" && f.subject.tag.startsWith("lang:")) {
      counts.set(f.subject.tag, (counts.get(f.subject.tag) ?? 0) + 1);
    }
  }
  const found = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tagLabel(tag));
  if (found.length > 0) return found;
  return [
    ...new Set(overview.inspection.modules.flatMap((m) => m.ecosystems.map((e) => ECOSYSTEM_LANGUAGE[e]))),
  ];
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
  const tokens = useMemo(() => (data ? understanding(data) : []), [data]);
  // The project's own colors: its languages' dyes, woven into its swatch.
  const langs = useMemo(() => (data ? languages(data) : []), [data]);
  const cloth = useMemo(() => stackDyes(langs), [langs]);
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
  // What it is written in, then what it is built on, then the tooling around it.
  const written = tokens.filter((t) => t.role === "language").map((t) => t.label);
  const builtOn = tokens.filter((t) => t.role !== "language");
  if (written.length === 0) written.push(...langs);
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
            <h1 className="project-title" title={project.path}>
              {project.name}
            </h1>
            {inspection.repository.branch ? (
              <span className="project-branch mono" title={`Branch ${inspection.repository.branch}`}>
                <Icon name="branch" size={12} /> {inspection.repository.branch}
              </span>
            ) : null}
            {project.sample ? <Label tone="thread">Sample project</Label> : null}
          </div>
          {inspection.description ? (
            <p className="project-description" title={inspection.description}>
              {inspection.description}
            </p>
          ) : null}
          <ul className="stack-tokens" aria-label="What Habi recognized">
            {written.map((l) => (
              <li
                key={l}
                className={`stack-token${stackDye(l) ? " is-dyed" : ""}`}
                style={stackDye(l) ? ({ "--dye": stackDye(l) } as CSSProperties) : undefined}
              >
                {l}
              </li>
            ))}
            {builtOn.map((t, i) => (
              <Fragment key={t.label}>
                {/* A hairline where a new kind starts: written in, built on, tooling. */}
                {(i === 0 && written.length > 0) || (i > 0 && builtOn[i - 1]?.role !== t.role) ? (
                  <li className="stack-rule" aria-hidden="true" />
                ) : null}
                <li className={`stack-token${t.role === "tooling" ? " stack-token-tool" : ""}`}>{t.label}</li>
              </Fragment>
            ))}
            {written.length === 0 && builtOn.length === 0 ? (
              <li className="stack-token stack-token-quiet">no recognized frameworks or languages</li>
            ) : null}
          </ul>
        </div>
        <div className="project-actions">
          <button
            type="button"
            className={`icon-btn${overview.isFetching ? " is-working" : ""}`}
            aria-label="Rescan"
            data-tip="Rescan — look at the project again"
            onClick={rescan}
            disabled={overview.isFetching}
          >
            <Icon name="refresh" />
          </button>
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
          <button
            type="button"
            className="icon-btn"
            aria-label="Show the folder"
            {...tip({ title: "Show the folder", lines: [{ text: project.path, mono: true }] })}
            onClick={() => safely(() => api.revealProjectPath(projectId, null), "The folder was not shown")}
          >
            <Icon name="folder" />
          </button>
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
