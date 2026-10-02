/**
 * Home. One question, one action, and the weave between them: your team's
 * knowledge sources as threads, converging into the action that opens a
 * project. Below, where you left off. Everything else (creating and adding
 * skills, connecting libraries) lives in the sidebar, the palette and the
 * project views, with keyboard shortcuts shown quietly at the foot.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
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
  useLibraries,
  useRecentProjects,
  useSkills,
  useSources,
} from "../lib/queries";
import { HomeWeave, type WeaveSkill, type WeaveSource } from "./HomeWeave";

const LOCAL = "local";

type Row =
  | { kind: "project"; id: string; name: string; meta: string; at: string; sources: string[] | null }
  | { kind: "draft"; id: string; name: string; meta: string; at: string };

export function Welcome() {
  const { navigate } = useNav();
  const { openProject } = useActions();
  const recent = useRecentProjects();
  const skills = useSkills();
  const sources = useSources();
  const libraries = useLibraries(sources.data ?? []);
  const dyes = useDyes();
  const client = useQueryClient();
  const toast = useToast();
  const [sampleBusy, setSampleBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [focus, setFocus] = useState<{ label: [string, string]; sources: string[] } | null>(null);
  const cta = useRef<HTMLDivElement>(null);
  const [ctaWidth, setCtaWidth] = useState(180);

  useLayoutEffect(() => {
    const button = cta.current?.querySelector("button");
    if (button) setCtaWidth(button.getBoundingClientRect().width);
  }, []);

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
  const libraryData = libraries.map((q) => q.data);
  const libraryKey = libraryData.map((d) => d?.snapshot ?? "").join("|");

  // Sources for the weave: libraries in connection order, then your skills.
  // biome-ignore lint/correctness/useExhaustiveDependencies: libraryKey stands for the library indexes.
  const weave = useMemo(() => {
    const fitsBy = new Map<string, number>();
    for (const p of projects)
      for (const id of p.summary?.sources ?? []) fitsBy.set(id, (fitsBy.get(id) ?? 0) + 1);
    const list: WeaveSource[] = [];
    const skillRows: WeaveSkill[][] = [];
    for (const s of [...(sources.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const index = libraryData.find((d) => d?.sourceId === s.id);
      const items = (index?.items ?? []).filter((i) => i.kind !== "instructions");
      if (!s.snapshot) continue;
      list.push({
        id: s.id,
        name: s.name,
        dye: dyes(s.id),
        kind: s.role,
        skills: items.length,
        fits: fitsBy.get(s.id) ?? 0,
      });
      skillRows.push(items.map((i) => ({ title: i.title, sourceId: s.id, sourceName: s.name })));
    }
    if (drafts.length > 0) {
      list.push({
        id: LOCAL,
        name: "My skills",
        dye: dyes(LOCAL),
        kind: "mine",
        skills: drafts.length,
        fits: fitsBy.get(LOCAL) ?? 0,
      });
      skillRows.push(
        drafts.map((d) => ({ title: d.title || "Untitled skill", sourceId: LOCAL, sourceName: "My skills" })),
      );
    }
    // One skill from each source in turn, so every thread is crossed.
    const crossing: WeaveSkill[] = [];
    for (let i = 0; crossing.length < 6 && skillRows.some((r) => r[i]); i++)
      for (const r of skillRows) if (r[i] && crossing.length < 6) crossing.push(r[i] as WeaveSkill);
    return { list, crossing };
  }, [sources.data, libraryKey, drafts.length, projects.length, dyes]);

  const total = weave.list.reduce((n, s) => n + s.skills, 0);
  const community = weave.list.some((s) => s.kind === "community");
  const summary: [string, string] | null =
    weave.list.length > 0
      ? [
          plural(weave.list.length, "source"),
          `${plural(total, "skill")}${community ? " · stitched threads: community" : ""}`,
        ]
      : null;

  const rows: Row[] = [
    ...projects.map(
      (p): Row => ({
        kind: "project",
        id: p.id,
        name: p.name,
        meta: p.summary
          ? `${plural(p.summary.fits, "skill")} · ${plural(p.summary.sources.length, "source")}`
          : "not matched yet",
        at: p.lastOpenedAt,
        sources: p.summary?.sources ?? null,
      }),
    ),
    ...drafts.map(
      (d): Row => ({
        kind: "draft",
        id: d.id,
        name: d.title || "Untitled skill",
        meta: "draft skill",
        at: d.updatedAt,
      }),
    ),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 4);

  const first = projects.length === 0;

  return (
    <div className="home">
      <div className="home-column">
        <h1 className="home-title">
          What does your team know that helps <em>here</em>?
        </h1>
        <p className="home-lead">Habi finds the skills and instructions that belong with your code.</p>

        <HomeWeave
          sources={weave.list}
          skills={weave.crossing}
          focus={focus}
          summary={summary}
          ctaWidth={ctaWidth}
          onOpenSource={(id) =>
            id === LOCAL ? navigate({ name: "skills" }) : navigate({ name: "sources", sourceId: id })
          }
        />

        <div className="home-cta" ref={cta}>
          <Button variant="primary" icon="folder" className="btn-lg" onClick={() => void openProject()}>
            Open a project…
          </Button>
          <span
            className="home-trust"
            title="Habi reads build files and folder names. Nothing is built, run or changed until you review and confirm a plan."
          >
            read-only
          </span>
        </div>

        {error ? <ErrorNotice error={error} /> : null}

        {rows.length > 0 ? (
          <section className="home-continue" aria-labelledby="home-continue">
            <h2 id="home-continue" className="kicker">
              Continue
            </h2>
            <ul>
              {rows.map((r) => (
                <li key={`${r.kind}:${r.id}`}>
                  <button
                    type="button"
                    className="continue-row"
                    onClick={() =>
                      r.kind === "project"
                        ? navigate({ name: "project", projectId: r.id, tab: "recommendations" })
                        : navigate({ name: "skills", skillId: r.id })
                    }
                    onMouseEnter={() =>
                      r.kind === "project" && r.sources
                        ? setFocus({ label: [r.name, r.meta], sources: r.sources })
                        : undefined
                    }
                    onFocus={() =>
                      r.kind === "project" && r.sources
                        ? setFocus({ label: [r.name, r.meta], sources: r.sources })
                        : undefined
                    }
                    onMouseLeave={() => setFocus(null)}
                    onBlur={() => setFocus(null)}
                  >
                    <Icon name={r.kind === "project" ? "folder" : "pencil"} size={14} />
                    <span className="continue-name">{r.name}</span>
                    <span className="continue-meta">{r.meta}</span>
                    <span className="continue-when">{relativeTime(r.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="home-foot">
          {first ? (
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
    </div>
  );
}
